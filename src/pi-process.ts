import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import type { CancelToken } from './cancel-token.js';
import {
    PiCancelledError,
    PiHungError,
    PiProtocolError,
    PiStartupError,
} from './errors.js';
import type { Logger } from './logger.js';
import { LineFramer } from './protocol/framer.js';
import { isRecord, type PiEvent, type RpcResponseRecord } from './protocol/events.js';
import {
    AGENT_SETTLED_VERSION,
    capabilitiesFor,
    compareSemver,
    MIN_PI_VERSION,
    parseSemver,
    type PiCapabilities,
    type SemVer,
} from './protocol/version.js';
import type { PromptImage } from './messages.js';
import type { ResolvedPiConfig } from './types.js';
import {
    dispatchExtensionUi,
    isDialogMethod,
    type ExtensionUiRequest,
    type PiUi,
} from './ui-protocol.js';
import { assertSafeAdditionalArgs, assertWorkspaceTrusted, buildRpcArgs } from './workspace-policy.js';
import { resolvePiLaunch, SHIM_READ_LIMIT, type PiLaunch, type PiLaunchIo } from './pi-launch.js';

export interface SpawnOptions {
    cwd?: string;
    stdio?: ['ignore' | 'pipe', 'ignore' | 'pipe', 'ignore' | 'pipe'];
    windowsHide?: boolean;
    env?: NodeJS.ProcessEnv;
}

export type SpawnImpl = (
    command: string,
    args: readonly string[],
    options: SpawnOptions
) => ChildProcess;

export interface PiModelInfo {
    id: string;
    provider: string;
    contextWindow: number;
    maxTokens: number;
}

interface PendingCommand {
    command: string;
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

interface RunWaiter {
    settled: boolean;
    promise: Promise<void>;
    finish: (error?: Error) => void;
    dispose: () => void;
}

const STDERR_LIMIT = 64 * 1024;
const RECORD_LIMIT = 32 * 1024 * 1024;

/**
 * JSONL RPC client for a user-installed `pi` binary.
 *
 * `@earendil-works/pi-coding-agent@0.74.0` does export `RpcClient` from the
 * package root. That client still completes on `agent_end` and speaks to
 * whatever CLI path it was constructed with, which is not the same thing as
 * the `pi` the user has on PATH. Current Pi (1.5.x) also exports `RpcClient`,
 * but the package requires Node >= 22.19 and would not track the installed
 * CLI. This class is the small LF-only transport instead.
 */
export class PiProcess {
    private child: ChildProcess | null = null;
    private readonly framer = new LineFramer();
    private readonly pending = new Map<string, PendingCommand>();
    private readonly listeners = new Set<(event: PiEvent) => void>();
    private requestSeq = 0;
    private queue: Promise<void> = Promise.resolve();
    private writeChain: Promise<void> = Promise.resolve();
    private stderr = '';
    private version: SemVer | undefined;
    private caps: PiCapabilities | undefined;
    private currentModelKey: string | undefined;
    private crashCount = 0;
    private shuttingDown = false;
    private closed = false;
    private ready = false;
    private startPromise: Promise<void> | undefined;
    private waiter: RunWaiter | undefined;
    private readonly openDialogs = new Set<string>();
    private terminalError: Error | undefined;
    private loggedLegacy = false;
    private launch: PiLaunch | undefined;

    constructor(
        private readonly config: ResolvedPiConfig,
        private readonly ui: PiUi,
        private readonly log: Logger,
        private readonly isTrusted: () => boolean,
        private readonly spawnImpl: SpawnImpl = spawn,
        private readonly baseEnv: NodeJS.ProcessEnv = process.env,
        private readonly platform: NodeJS.Platform = process.platform,
        private readonly launchIo: PiLaunchIo = defaultLaunchIo
    ) {}

    get alive(): boolean {
        return !!this.child && this.child.exitCode === null && !this.child.killed;
    }

    get capabilities(): PiCapabilities | undefined {
        return this.caps;
    }

    async ensureReady(): Promise<void> {
        return this.enqueue(() => this.ensureStarted());
    }

    async newSession(): Promise<void> {
        return this.enqueue(async () => {
            await this.ensureStarted();
            const data = await this.command('new_session', {}, this.config.commandTimeoutMs);
            if (isRecord(data) && data.cancelled === true) {
                throw new PiProtocolError(
                    'Pi cancelled new_session. An extension refused to start a session, so this turn was not sent.'
                );
            }
            this.currentModelKey = undefined;
        });
    }

    async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
        return this.enqueue(async () => {
            await this.ensureStarted();
            const data = await this.command(
                'switch_session',
                { sessionPath },
                this.config.commandTimeoutMs
            );
            this.currentModelKey = undefined;
            return { cancelled: isRecord(data) && data.cancelled === true };
        });
    }

    async sendPrompt(options: {
        prompt: string;
        images?: PromptImage[];
        model: { provider: string; modelId: string };
        onEvent: (event: PiEvent) => void;
        token: CancelToken;
    }): Promise<void> {
        return this.enqueue(() => this.sendPromptBody(options));
    }

    async getLastAssistantText(): Promise<string | null> {
        return this.enqueue(async () => {
            await this.ensureStarted();
            const data = await this.command('get_last_assistant_text', {}, this.config.commandTimeoutMs);
            if (isRecord(data) && (typeof data.text === 'string' || data.text === null)) {
                return data.text;
            }
            return null;
        });
    }

    async getState(): Promise<Record<string, unknown>> {
        return this.enqueue(async () => {
            await this.ensureStarted();
            const data = await this.command('get_state', {}, this.config.commandTimeoutMs);
            return isRecord(data) ? data : {};
        });
    }

    async getSessionStats(): Promise<Record<string, unknown>> {
        return this.enqueue(async () => {
            await this.ensureStarted();
            const data = await this.command('get_session_stats', {}, this.config.commandTimeoutMs);
            return isRecord(data) ? data : {};
        });
    }

    /** Pi version from the last successful `--version` probe, if this process reached one. */
    probedVersion(): string | undefined {
        return this.version?.raw;
    }

    async getAvailableModels(): Promise<PiModelInfo[]> {
        return this.enqueue(async () => {
            await this.ensureStarted();
            const data = await this.command('get_available_models', {}, this.config.commandTimeoutMs);
            const models = normalizeModels(data);
            if (!Array.isArray(data) && !(isRecord(data) && Array.isArray(data.models))) {
                throw new PiProtocolError(
                    'Pi get_available_models returned an unexpected payload. ' +
                    'Check the Pi Agent output and that `pi --mode rpc` works in a terminal.'
                );
            }
            this.log.info(`Pi reported ${models.length} model(s).`);
            return models;
        });
    }

    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        this.terminalError = new PiProtocolError('Pi process shutdown');
        await this.destroyProcess('shutdown');
    }

    private async sendPromptBody(options: {
        prompt: string;
        images?: PromptImage[];
        model: { provider: string; modelId: string };
        onEvent: (event: PiEvent) => void;
        token: CancelToken;
    }): Promise<void> {
        await this.ensureStarted();
        const caps = this.caps;
        if (!caps) {
            throw new PiStartupError('Pi capabilities were not detected.');
        }
        const modelKey = `${options.model.provider}/${options.model.modelId}`;
        if (this.currentModelKey !== modelKey) {
            await this.command('set_model', {
                provider: options.model.provider,
                modelId: options.model.modelId,
            }, this.config.commandTimeoutMs);
            this.currentModelKey = modelKey;
        }

        const unsubscribe = this.onEvent(options.onEvent);
        const waiter = this.beginRun(options.token, caps);
        try {
            if (options.token.isCancellationRequested) {
                throw new PiCancelledError();
            }
            const params: Record<string, unknown> = { message: options.prompt };
            if (options.images && options.images.length > 0) {
                params.images = options.images;
            }
            const data = await this.command('prompt', params, this.config.commandTimeoutMs);
            if (options.token.isCancellationRequested) {
                throw new PiCancelledError();
            }
            const disposition = isRecord(data) && typeof data.disposition === 'string'
                ? data.disposition
                : undefined;
            if (disposition === 'handled') {
                this.log.info('Pi handled the prompt without starting a run.');
                waiter.finish();
                this.crashCount = 0;
                return;
            }
            await waiter.promise;
            this.crashCount = 0;
        } finally {
            unsubscribe();
            waiter.dispose();
            if (this.waiter === waiter) {
                this.waiter = undefined;
            }
        }
    }

    private beginRun(token: CancelToken, caps: PiCapabilities): RunWaiter {
        let resolveRun: () => void = () => undefined;
        let rejectRun: (error: Error) => void = () => undefined;
        const promise = new Promise<void>((resolve, reject) => {
            resolveRun = resolve;
            rejectRun = reject;
        });
        void promise.catch(() => undefined);
        const waiter: RunWaiter = {
            settled: false,
            promise,
            finish: (error?: Error) => {
                if (waiter.settled) {
                    return;
                }
                waiter.settled = true;
                if (error) {
                    rejectRun(error);
                } else {
                    resolveRun();
                }
            },
            dispose: () => {
                subscription.dispose();
                if (hungTimer) {
                    clearTimeout(hungTimer);
                }
            },
        };
        this.waiter = waiter;

        let hungTimer: NodeJS.Timeout | undefined;
        const armHung = () => {
            if (hungTimer) {
                clearTimeout(hungTimer);
                hungTimer = undefined;
            }
            if (waiter.settled || this.config.hungRequestTimeoutMs <= 0 || this.openDialogs.size > 0) {
                return;
            }
            hungTimer = setTimeout(() => {
                void this.handleHung(waiter);
            }, this.config.hungRequestTimeoutMs);
        };
        this.armHung = armHung;

        const onRunEvent = (event: PiEvent) => {
            armHung();
            if (waiter.settled) {
                return;
            }
            const finished = caps.agentSettled ? event.type === 'agent_settled' : event.type === 'agent_end';
            if (!finished) {
                return;
            }
            if (token.isCancellationRequested) {
                waiter.finish(new PiCancelledError());
            } else {
                waiter.finish();
            }
        };
        const removeRunEvent = this.onEvent(onRunEvent);
        const originalDispose = waiter.dispose;
        waiter.dispose = () => {
            removeRunEvent();
            originalDispose();
            if (this.armHung === armHung) {
                this.armHung = undefined;
            }
        };

        const subscription = token.onCancellationRequested(() => {
            void this.handleCancel(waiter);
        });
        armHung();
        return waiter;
    }

    private armHung: (() => void) | undefined;

    private async handleCancel(waiter: RunWaiter): Promise<void> {
        if (waiter.settled) {
            return;
        }
        this.log.info('Cancellation requested. Clearing queued Pi work, then aborting.');
        this.terminalError = new PiCancelledError();
        await this.cancelDialogs();
        await this.cancelRpc();
        if (waiter.settled) {
            return;
        }
        await Promise.race([
            waiter.promise.then(() => undefined, () => undefined),
            delay(this.config.shutdownGraceMs),
        ]);
        if (waiter.settled) {
            return;
        }
        await this.destroyProcess('cancelled');
        waiter.finish(new PiCancelledError());
    }

    private async handleHung(waiter: RunWaiter): Promise<void> {
        if (waiter.settled) {
            return;
        }
        const message =
            `No Pi protocol output for ${this.config.hungRequestTimeoutMs}ms, so this request was aborted. ` +
            'Output from a running task resets the timer. Set pi.hungRequestTimeoutMs higher, or set it to 0 to disable the inactivity timeout. ' +
            this.stderrTail();
        this.log.info(message);
        this.terminalError = new PiHungError(message);
        await this.cancelDialogs();
        await this.cancelRpc();
        if (waiter.settled) {
            return;
        }
        await Promise.race([
            waiter.promise.then(() => undefined, () => undefined),
            delay(this.config.shutdownGraceMs),
        ]);
        if (waiter.settled) {
            return;
        }
        await this.destroyProcess('hung');
        waiter.finish(this.terminalError);
    }

    private async cancelRpc(): Promise<void> {
        const timeout = Math.min(this.config.commandTimeoutMs, Math.max(this.config.shutdownGraceMs, 200));
        if (this.caps?.clearQueue) {
            try {
                await this.command('clear_queue', {}, timeout);
            } catch (error) {
                this.log.info(`clear_queue failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else {
            this.log.info(
                `Pi ${this.version?.raw ?? 'unknown'} has no clear_queue command. ` +
                'Aborting without it can still run queued steering or follow-up messages. ' +
                `Upgrade Pi to ${'0.84.4'} or newer to clear that queue.`
            );
        }
        try {
            await this.command('abort', {}, timeout);
        } catch (error) {
            this.log.info(`abort failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async ensureStarted(): Promise<void> {
        if (this.ready && this.alive) {
            return;
        }
        if (this.startPromise) {
            return this.startPromise;
        }
        this.startPromise = this.start().finally(() => {
            this.startPromise = undefined;
        });
        return this.startPromise;
    }

    private async start(): Promise<void> {
        assertWorkspaceTrusted(this.isTrusted());
        assertSafeAdditionalArgs(this.config.additionalArgs);
        if (this.shuttingDown) {
            throw new PiStartupError('Pi is shutting down.');
        }
        if (!this.config.autoRestart && this.crashCount > 0) {
            throw new PiStartupError(
                'Pi exited and pi.autoRestart is false, so a new process was not started. ' +
                `Last stderr: ${this.stderrTail()}`
            );
        }
        if (this.crashCount > this.config.maxRestartAttempts) {
            throw new PiStartupError(
                `Pi exited unexpectedly ${this.crashCount} time(s) ` +
                `(pi.maxRestartAttempts is ${this.config.maxRestartAttempts}). ` +
                `Last stderr: ${this.stderrTail()}`
            );
        }

        const version = await this.readVersion();
        this.caps = capabilitiesFor(version);
        if (!this.caps.agentSettled && !this.loggedLegacy) {
            this.loggedLegacy = true;
            this.log.info(
                `Pi ${version.raw} does not emit agent_settled (added in ${AGENT_SETTLED_VERSION.raw}). ` +
                'This turn finishes on the first agent_end, which can arrive before retries, compaction, or queued follow-ups. ' +
                `Upgrade Pi to ${AGENT_SETTLED_VERSION.raw} or newer for full completion.`
            );
        }

        if (this.config.sessionDir) {
            fs.mkdirSync(this.config.sessionDir, { recursive: true });
        }
        const args = buildRpcArgs({
            additionalArgs: this.config.additionalArgs,
            sessionDir: this.config.sessionDir,
        });
        const launch = this.getLaunch();
        this.log.info(`Starting Pi ${version.raw}: ${launch.summary} args: ${args.join(' ')}`);
        this.framer.reset();
        this.stderr = '';
        this.terminalError = undefined;
        this.closed = false;
        this.ready = false;

        let child: ChildProcess;
        try {
            child = this.spawnConfigured(args, ['pipe', 'pipe', 'pipe']);
        } catch (error) {
            throw this.startupError(error);
        }
        this.child = child;
        child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
        child.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));
        child.on('error', (error) => {
            this.failProcess(this.startupError(error));
        });
        child.on('exit', (code, signal) => {
            if (this.child !== child) {
                return;
            }
            const message = `Pi process exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}). ${this.stderrTail()}`;
            this.failProcess(this.terminalError ?? new PiProtocolError(message));
        });

        try {
            await this.waitUntilSpawned(child);
            await this.command('get_state', {}, this.config.commandTimeoutMs);
            this.ready = true;
            this.log.info(`Pi ${version.raw} RPC is ready.`);
        } catch (error) {
            await this.destroyProcess('startup');
            if (error instanceof PiStartupError || error instanceof PiProtocolError) {
                throw error;
            }
            throw new PiStartupError(
                `Pi RPC did not become ready. ${error instanceof Error ? error.message : String(error)} ${this.stderrTail()}`
            );
        }
    }

    private async readVersion(): Promise<SemVer> {
        if (this.version) {
            return this.version;
        }
        const result = await this.exec(['--version']);
        if (result.error) {
            throw this.startupError(result.error);
        }
        if (result.code !== 0) {
            throw new PiStartupError(
                `\`${this.config.binaryPath} --version\` exited ${result.code}. ${result.stderr.trim()}`.trim()
            );
        }
        const parsed = parseSemver(result.stdout);
        if (!parsed) {
            throw new PiStartupError(
                `Could not read a Pi version from \`${this.config.binaryPath} --version\`. ` +
                `Output was: ${result.stdout.trim() || '(empty)'}. ` +
                'Install Pi with `npm install -g @earendil-works/pi-coding-agent` or set pi.binaryPath to the executable.'
            );
        }
        if (compareSemver(parsed, MIN_PI_VERSION) < 0) {
            throw new PiStartupError(
                `Pi ${parsed.raw} at "${this.config.binaryPath}" is older than ${MIN_PI_VERSION.raw}, which is the oldest version this fork supports. ` +
                'Install a newer Pi with `npm install -g @earendil-works/pi-coding-agent`. ' +
                `Completion tracking (agent_settled) needs ${AGENT_SETTLED_VERSION.raw} or newer; ` +
                `${MIN_PI_VERSION.raw} through ${AGENT_SETTLED_VERSION.raw} finishes on the first agent_end.`
            );
        }
        this.version = parsed;
        this.log.info(`Detected Pi ${parsed.raw} at ${this.config.binaryPath}.`);
        return parsed;
    }

    private exec(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
        return new Promise((resolve) => {
            let child: ChildProcess;
            try {
                child = this.spawnConfigured(args, ['ignore', 'pipe', 'pipe']);
            } catch (error) {
                resolve({ code: null, stdout: '', stderr: '', error: error instanceof Error ? error : new Error(String(error)) });
                return;
            }
            let stdout = '';
            let stderr = '';
            let done = false;
            const finish = (result: { code: number | null; stdout: string; stderr: string; error?: Error }) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                resolve(result);
            };
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                finish({
                    code: null,
                    stdout,
                    stderr,
                    error: new Error(`\`${this.config.binaryPath} ${args.join(' ')}\` timed out after ${this.config.commandTimeoutMs}ms.`),
                });
            }, this.config.commandTimeoutMs);
            child.stdout?.on('data', (chunk: Buffer) => {
                stdout += chunk.toString('utf8');
            });
            child.stderr?.on('data', (chunk: Buffer) => {
                stderr += chunk.toString('utf8');
            });
            child.once('error', (error) => finish({ code: null, stdout, stderr, error }));
            child.once('exit', (code) => finish({ code, stdout, stderr }));
        });
    }

    private waitUntilSpawned(child: ChildProcess): Promise<void> {
        return new Promise((resolve, reject) => {
            let done = false;
            const finish = (error?: Error) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                child.off('error', onError);
                child.off('exit', onExit);
                child.off('spawn', onSpawn);
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };
            const onError = (error: Error) => finish(this.startupError(error));
            const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
                finish(new PiStartupError(
                    `Pi exited before RPC was ready (code ${code ?? 'null'}, signal ${signal ?? 'none'}). ${this.stderrTail()}`
                ));
            };
            const onSpawn = () => finish();
            const timer = setTimeout(() => {
                finish(new PiStartupError(
                    `Pi did not start within ${this.config.commandTimeoutMs}ms. ${this.stderrTail()}`
                ));
            }, this.config.commandTimeoutMs);
            child.once('error', onError);
            child.once('exit', onExit);
            child.once('spawn', onSpawn);
        });
    }

    private onStdout(chunk: Buffer): void {
        const lines = this.framer.push(chunk);
        if (this.framer.remainder().length > RECORD_LIMIT) {
            this.failProcess(new PiProtocolError(
                'Pi stdout produced a record larger than 32MB without a newline. The process was stopped.'
            ));
            return;
        }
        for (const line of lines) {
            this.handleLine(line);
        }
    }

    private onStderr(chunk: Buffer): void {
        this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT);
        const text = chunk.toString('utf8').trim();
        if (text && this.config.debug) {
            this.log.debug(`[stderr] ${text}`);
        }
    }

    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        this.armHung?.();
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch (error) {
            this.log.info(
                `Failed to parse a Pi stdout record (${trimmed.length} bytes): ` +
                `${error instanceof Error ? error.message : String(error)}`
            );
            return;
        }
        if (!isRecord(parsed) || typeof parsed.type !== 'string') {
            this.log.info('Ignored a Pi stdout record without a string type.');
            return;
        }
        if (parsed.type === 'response') {
            this.handleResponse(parsed as unknown as RpcResponseRecord);
            return;
        }
        if (parsed.type === 'extension_ui_request') {
            this.handleUi(parsed);
            return;
        }
        const event = parsed as PiEvent;
        if (this.config.debug) {
            this.log.debug(`[event] ${trimmed}`);
        } else {
            this.log.info(`[event] ${event.type}`);
        }
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch (error) {
                this.log.info(`Pi event listener failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private handleResponse(message: RpcResponseRecord): void {
        const id = typeof message.id === 'string' ? message.id : undefined;
        if (!id) {
            const detail = typeof message.error === 'string' ? message.error : 'no id';
            this.log.info(`Pi response without an id (${message.command ?? 'unknown'}): ${detail}`);
            return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
            this.log.info(`Pi response for unknown id ${id} (${message.command ?? 'unknown'}).`);
            return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (message.command && message.command !== pending.command) {
            this.log.info(`Pi response command ${message.command} did not match ${pending.command} for ${id}.`);
        }
        const failed = message.success === false || (typeof message.error === 'string' && message.error.length > 0 && message.success !== true);
        if (failed) {
            pending.reject(new PiProtocolError(
                typeof message.error === 'string' && message.error.length > 0
                    ? message.error
                    : `Pi command ${pending.command} failed.`
            ));
            return;
        }
        pending.resolve(message.data);
    }

    private handleUi(record: Record<string, unknown>): void {
        const id = typeof record.id === 'string' ? record.id : '';
        const method = typeof record.method === 'string' ? record.method : '';
        if (!id || !method) {
            this.log.info('Ignored an extension_ui_request without an id and method.');
            return;
        }
        const request = record as unknown as ExtensionUiRequest;
        this.log.info(`[ui] ${method} ${id}`);
        if (!isDialogMethod(method) && !isKnownNotification(method)) {
            this.log.info(
                `Pi sent extension UI method "${method}", which this provider does not implement. No response was sent.`
            );
        }
        if (isDialogMethod(method)) {
            this.openDialogs.add(id);
            this.armHung?.();
        }
        void this.finishUi(request);
    }

    private async finishUi(request: ExtensionUiRequest): Promise<void> {
        try {
            const response = await dispatchExtensionUi(request, this.ui);
            if (!isDialogMethod(request.method)) {
                return;
            }
            if (!this.openDialogs.has(request.id)) {
                return;
            }
            this.openDialogs.delete(request.id);
            if (response) {
                await this.writeRaw(response);
            }
        } catch (error) {
            this.log.info(`Pi UI ${request.method} failed: ${error instanceof Error ? error.message : String(error)}`);
            if (this.openDialogs.has(request.id)) {
                this.openDialogs.delete(request.id);
                try {
                    await this.writeRaw({ type: 'extension_ui_response', id: request.id, cancelled: true });
                } catch {
                    /* stdin may already be closed */
                }
            }
        } finally {
            this.armHung?.();
        }
    }

    private async cancelDialogs(): Promise<void> {
        const ids = [...this.openDialogs];
        this.openDialogs.clear();
        for (const id of ids) {
            try {
                await this.writeRaw({ type: 'extension_ui_response', id, cancelled: true });
            } catch {
                /* process is going away */
            }
        }
        this.armHung?.();
    }

    private command(type: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
        if (!this.child || this.child.exitCode !== null) {
            return Promise.reject(new PiProtocolError('Pi process is not running.'));
        }
        const id = `req_${++this.requestSeq}`;
        const payload = { ...params, type, id };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.pending.has(id)) {
                    return;
                }
                this.pending.delete(id);
                reject(new PiProtocolError(
                    `RPC command "${type}" timed out after ${timeoutMs}ms. ` +
                    'Raise pi.commandTimeoutMs if Pi is slow to accept commands. ' +
                    this.stderrTail()
                ));
            }, timeoutMs);
            this.pending.set(id, { command: type, resolve, reject, timer });
            void this.writeRaw(payload).catch((error: unknown) => {
                if (!this.pending.has(id)) {
                    return;
                }
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new PiProtocolError(String(error)));
            });
        });
    }

    private writeRaw(value: unknown): Promise<void> {
        const task = this.writeChain.then(async () => {
            const stdin = this.child?.stdin;
            if (!stdin || !this.child || this.child.exitCode !== null) {
                throw new PiProtocolError('Pi stdin is closed.');
            }
            const record = isRecord(value) ? value : {};
            if (this.config.debug) {
                this.log.debug(`[send] ${summarizePayload(value)}`);
            } else {
                const type = typeof record.type === 'string' ? record.type : 'record';
                const id = typeof record.id === 'string' ? record.id : '';
                this.log.info(`[send] ${type} ${id}`.trim());
            }
            const line = `${JSON.stringify(value)}\n`;
            if (!stdin.write(line)) {
                await once(stdin, 'drain');
            }
        });
        this.writeChain = task.then(() => undefined, () => undefined);
        return task;
    }

    private async destroyProcess(reason: string): Promise<void> {
        const child = this.child;
        if (!child) {
            this.failProcess(this.terminalError ?? new PiProtocolError(`Pi process stopped (${reason}).`));
            return;
        }
        const exitPromise = once(child, 'exit').then(() => true, () => true);
        try {
            child.stdin?.end();
        } catch {
            /* already closed */
        }
        if (child.exitCode === null && !child.killed) {
            try {
                child.kill('SIGTERM');
            } catch {
                /* already gone */
            }
        }
        const exited = await Promise.race([
            exitPromise,
            delay(this.config.shutdownGraceMs).then(() => false),
        ]);
        if (!exited && child.exitCode === null) {
            try {
                child.kill('SIGKILL');
            } catch {
                /* already gone */
            }
            await Promise.race([once(child, 'exit').then(() => undefined, () => undefined), delay(1000)]);
        }
        if (this.child === child) {
            this.failProcess(this.terminalError ?? new PiProtocolError(`Pi process stopped (${reason}). ${this.stderrTail()}`));
        }
    }

    private failProcess(error: Error): void {
        if (this.closed) {
            this.rejectAll(this.terminalError ?? error);
            return;
        }
        this.closed = true;
        const reported = this.terminalError ?? error;
        this.ready = false;
        this.currentModelKey = undefined;
        if (!this.shuttingDown && this.terminalError === undefined) {
            this.crashCount++;
            this.log.info(reported.message);
        }
        this.child = null;
        this.rejectAll(reported);
        this.waiter?.finish(reported);
        this.openDialogs.clear();
    }

    private rejectAll(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    private onEvent(listener: (event: PiEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn, fn);
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }

    private getLaunch(): PiLaunch {
        if (this.launch) {
            return this.launch;
        }
        const resolved = resolvePiLaunch({
            binaryPath: this.config.binaryPath,
            cwd: this.config.cwd,
            env: this.baseEnv,
            platform: this.platform,
            io: this.launchIo,
        });
        if (!resolved.ok) {
            throw new PiStartupError(resolved.message);
        }
        this.launch = resolved.launch;
        this.log.info(resolved.launch.summary);
        return resolved.launch;
    }

    private spawnConfigured(
        args: readonly string[],
        stdio: ['ignore' | 'pipe', 'ignore' | 'pipe', 'ignore' | 'pipe']
    ): ChildProcess {
        const launch = this.getLaunch();
        return this.spawnImpl(launch.command, [...launch.prefixArgs, ...args], {
            cwd: this.config.cwd,
            stdio,
            windowsHide: true,
            env: this.baseEnv,
        });
    }

    private startupError(error: unknown): PiStartupError {
        if (error instanceof PiStartupError) {
            return error;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('ENOENT') || message.toLowerCase().includes('not found')) {
            if (this.launch) {
                const prefix = this.launch.prefixArgs.length > 0 ? ` ${this.launch.prefixArgs.join(' ')}` : '';
                return new PiStartupError(
                    `Pi was resolved from "${this.launch.source}" to "${this.launch.command}"${prefix}, ` +
                    `but the process could not be started (${message}). The command was not run in a shell.`
                );
            }
            return new PiStartupError(
                `Pi command "${this.config.binaryPath}" could not be started (${message}). ` +
                'On Windows this usually means the npm shim was spawned directly. ' +
                'Set pi.binaryPath to the full path of pi.cmd or of Pi\'s cli.js.'
            );
        }
        return new PiStartupError(message);
    }

    private stderrTail(): string {
        const text = this.stderr.trim();
        if (!text) {
            return '';
        }
        return `stderr: ${text.slice(-2000)}`;
    }
}

function normalizeModels(data: unknown): PiModelInfo[] {
    const list = Array.isArray(data)
        ? data
        : isRecord(data) && Array.isArray(data.models)
            ? data.models
            : [];
    const models: PiModelInfo[] = [];
    for (const entry of list) {
        if (!isRecord(entry)) {
            continue;
        }
        const id = typeof entry.id === 'string'
            ? entry.id
            : typeof entry.modelId === 'string'
                ? entry.modelId
                : '';
        const provider = typeof entry.provider === 'string' ? entry.provider : '';
        if (!id || !provider) {
            continue;
        }
        models.push({
            id,
            provider,
            contextWindow: typeof entry.contextWindow === 'number' ? entry.contextWindow : 200000,
            maxTokens: typeof entry.maxTokens === 'number' ? entry.maxTokens : 16384,
        });
    }
    return models;
}

function summarizePayload(value: unknown): string {
    try {
        return JSON.stringify(value, (_key, nested) => {
            if (typeof nested === 'string' && nested.length > 120) {
                return `${nested.slice(0, 24)}…(${nested.length} chars)`;
            }
            return nested;
        });
    } catch {
        return '[unserializable]';
    }
}

function isKnownNotification(method: string): boolean {
    return method === 'notify' || method === 'setStatus' || method === 'setWidget' || method === 'setTitle' || method === 'set_editor_text';
}

const defaultLaunchIo: PiLaunchIo = {
    exists: (filePath) => fs.existsSync(filePath),
    read: (filePath) => {
        try {
            const body = fs.readFileSync(filePath);
            if (body.length > SHIM_READ_LIMIT) {
                return { text: '', head: '', tooLarge: true };
            }
            return {
                text: body.toString('utf8'),
                head: body.subarray(0, 2).toString('latin1'),
            };
        } catch {
            return undefined;
        }
    },
};

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
