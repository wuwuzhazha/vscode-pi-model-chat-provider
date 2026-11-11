import type { CancelToken } from './cancel-token.js';
import { PiCancelledError } from './errors.js';
import {
    canonicalTranscript,
    preparePrompt,
    type InboundMessage,
    type PreparedPrompt,
    type PromptImage,
} from './messages.js';
import type { PiEvent } from './protocol/events.js';
import type { SessionIndex } from './session-index.js';

export interface TurnModel {
    provider: string;
    modelId: string;
}

export interface TurnClient {
    ensureReady(): Promise<void>;
    newSession(): Promise<void>;
    switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
    sendPrompt(options: {
        prompt: string;
        images?: PromptImage[];
        model: TurnModel;
        onEvent: (event: PiEvent) => void;
        token: CancelToken;
    }): Promise<void>;
    getLastAssistantText(): Promise<string | null>;
    getState(): Promise<Record<string, unknown>>;
    getSessionStats(): Promise<Record<string, unknown>>;
    shutdown(): Promise<void>;
    readonly alive: boolean;
}

export interface TurnRequest {
    messages: readonly InboundMessage[];
    model: TurnModel;
    /** Registration id, included in the session key so models do not share a process. */
    modelKey: string;
    cwd: string;
    token: CancelToken;
    onEvent: (event: PiEvent) => void;
}

export interface TurnOutcome {
    limitations: string[];
    duplicate: boolean;
    restored: boolean;
    getLastAssistantText: () => Promise<string | null>;
    getState: () => Promise<Record<string, unknown>>;
    getSessionStats: () => Promise<Record<string, unknown>>;
}

interface LiveSession {
    id: string;
    client: TurnClient;
    canonical: string;
    messageCount: number;
    modelKey: string;
    cwd: string;
    lastActivity: number;
    busy: number;
    queue: Promise<void>;
}

export interface SessionCoordinatorOptions {
    createClient: () => TurnClient;
    maxSessions: number;
    idleTimeoutMs: number;
    index?: SessionIndex;
    now?: () => number;
}

/**
 * In-memory session identity.
 *
 * A request continues an existing Pi process only when its transcript is a
 * strict extension of the transcript that process already accepted.
 * Edits, model changes, folder changes, cancellation, and crashes start a
 * new process. Opt-in persistence can reload Pi's session file for a prefix
 * that was recorded in the workspace index.
 *
 * Requests for one process run FIFO. Different processes may run together.
 */
export class SessionCoordinator {
    private readonly sessions = new Map<string, LiveSession>();
    private chain: Promise<void> = Promise.resolve();
    private seq = 0;
    private readonly now: () => number;
    private idleTimer: NodeJS.Timeout | undefined;

    constructor(private readonly options: SessionCoordinatorOptions) {
        this.now = options.now ?? Date.now;
        if (options.idleTimeoutMs > 0) {
            this.idleTimer = setInterval(() => this.expireIdle(), 60_000);
            this.idleTimer.unref?.();
        }
    }

    async run(request: TurnRequest): Promise<TurnOutcome> {
        const reserved = await this.reserve(request);
        return this.onSession(reserved.session, async () => {
            try {
                if (request.token.isCancellationRequested) {
                    throw new PiCancelledError();
                }
                const prepared = await this.openSession(reserved, request);
                if (!prepared.send) {
                    return this.outcome(reserved.session, prepared.limitations, true, reserved.restored);
                }
                await reserved.session.client.sendPrompt({
                    prompt: prepared.text,
                    images: prepared.images,
                    model: request.model,
                    onEvent: request.onEvent,
                    token: request.token,
                });
                await this.rememberSessionFile(reserved.session);
                return this.outcome(reserved.session, prepared.limitations, false, reserved.restored);
            } catch (error) {
                await this.drop(reserved.session);
                throw error;
            } finally {
                reserved.session.busy = Math.max(0, reserved.session.busy - 1);
                reserved.session.lastActivity = this.now();
            }
        });
    }

    expireIdle(at = this.now()): void {
        for (const session of [...this.sessions.values()]) {
            if (session.busy === 0 && at - session.lastActivity > this.options.idleTimeoutMs) {
                void this.drop(session);
            }
        }
    }

    async dispose(): Promise<void> {
        if (this.idleTimer) {
            clearInterval(this.idleTimer);
            this.idleTimer = undefined;
        }
        const sessions = [...this.sessions.values()];
        this.sessions.clear();
        await Promise.all(sessions.map(async (session) => {
            try {
                await session.client.shutdown();
            } catch {
                /* shutdown is best-effort */
            }
        }));
    }

    get size(): number {
        return this.sessions.size;
    }

    private outcome(
        session: LiveSession,
        limitations: string[],
        duplicate: boolean,
        restored: boolean
    ): TurnOutcome {
        return {
            limitations,
            duplicate,
            restored,
            getLastAssistantText: () => session.client.getLastAssistantText(),
            getState: () => session.client.getState(),
            getSessionStats: () => session.client.getSessionStats(),
        };
    }

    private async openSession(
        reserved: Reservation,
        request: TurnRequest
    ): Promise<PreparedPrompt> {
        const client = reserved.session.client;
        await client.ensureReady();
        if (reserved.restorePath) {
            try {
                const switched = await client.switchSession(reserved.restorePath);
                if (!switched.cancelled) {
                    return reserved.prepared;
                }
            } catch {
                /* fall through to a fresh replay */
            }
            const replay = preparePrompt(request.messages, 'replay');
            replay.limitations.unshift(
                `Saved Pi session ${reserved.restorePath} could not be restored. The transcript was resent as text.`
            );
            await client.newSession();
            return replay;
        }
        if (reserved.mode === 'continuation' || reserved.mode === 'duplicate') {
            return reserved.prepared;
        }
        await client.newSession();
        return reserved.prepared;
    }

    private async rememberSessionFile(session: LiveSession): Promise<void> {
        if (!this.options.index || !session.canonical) {
            return;
        }
        try {
            const state = await session.client.getState();
            const sessionFile = state.sessionFile;
            if (typeof sessionFile === 'string' && sessionFile.length > 0) {
                this.options.index.set(session.canonical, sessionFile);
            }
        } catch {
            /* indexing is best-effort; the in-memory session still stands */
        }
    }

    private async reserve(request: TurnRequest): Promise<Reservation> {
        return this.withLock(async () => {
            const full = canonicalTranscript(request.messages, request.modelKey, request.cwd);
            const exact = this.findExact(full, request);
            if (exact) {
                exact.busy++;
                exact.lastActivity = this.now();
                return {
                    session: exact,
                    mode: 'duplicate',
                    prepared: emptyPrompt(),
                    restored: false,
                };
            }

            const prefix = this.findPrefix(request, full);
            if (prefix) {
                const suffix = request.messages.slice(prefix.messageCount);
                const prepared = preparePrompt(suffix, 'continuation');
                prefix.canonical = full;
                prefix.messageCount = request.messages.length;
                prefix.busy++;
                prefix.lastActivity = this.now();
                return { session: prefix, mode: 'continuation', prepared, restored: false };
            }

            const persisted = this.findPersistedPrefix(request);
            const session = this.createSession(request, full);
            if (persisted && persisted.count < request.messages.length) {
                const prepared = preparePrompt(request.messages.slice(persisted.count), 'continuation');
                return {
                    session,
                    mode: 'restore',
                    prepared,
                    restorePath: persisted.sessionFile,
                    restored: true,
                };
            }
            if (persisted && persisted.count === request.messages.length) {
                return {
                    session,
                    mode: 'duplicate',
                    prepared: emptyPrompt(),
                    restorePath: persisted.sessionFile,
                    restored: true,
                };
            }
            return {
                session,
                mode: 'replay',
                prepared: preparePrompt(request.messages, 'replay'),
                restored: false,
            };
        });
    }

    private findExact(full: string, request: TurnRequest): LiveSession | undefined {
        for (const session of this.sessions.values()) {
            if (session.modelKey === request.modelKey && session.cwd === request.cwd && session.canonical === full && session.client.alive) {
                return session;
            }
        }
        return undefined;
    }

    private findPrefix(request: TurnRequest, full: string): LiveSession | undefined {
        let best: LiveSession | undefined;
        for (const session of this.sessions.values()) {
            if (session.modelKey !== request.modelKey || session.cwd !== request.cwd || !session.client.alive) {
                continue;
            }
            if (session.messageCount <= 0 || session.messageCount >= request.messages.length) {
                continue;
            }
            const prefix = canonicalTranscript(
                request.messages.slice(0, session.messageCount),
                request.modelKey,
                request.cwd
            );
            if (prefix === session.canonical && full.startsWith(prefix) && (!best || session.messageCount > best.messageCount)) {
                best = session;
            }
        }
        return best;
    }

    private findPersistedPrefix(request: TurnRequest): { count: number; sessionFile: string } | undefined {
        const index = this.options.index;
        if (!index) {
            return undefined;
        }
        for (let count = request.messages.length; count >= 1; count--) {
            const canonical = canonicalTranscript(
                request.messages.slice(0, count),
                request.modelKey,
                request.cwd
            );
            const sessionFile = index.get(canonical);
            if (sessionFile) {
                return { count, sessionFile };
            }
        }
        return undefined;
    }

    private createSession(request: TurnRequest, full: string): LiveSession {
        this.evictIdleIfNeeded();
        const session: LiveSession = {
            id: `s${++this.seq}`,
            client: this.options.createClient(),
            canonical: full,
            messageCount: request.messages.length,
            modelKey: request.modelKey,
            cwd: request.cwd,
            lastActivity: this.now(),
            busy: 1,
            queue: Promise.resolve(),
        };
        this.sessions.set(session.id, session);
        return session;
    }

    private evictIdleIfNeeded(): void {
        if (this.sessions.size < this.options.maxSessions) {
            return;
        }
        let oldest: LiveSession | undefined;
        for (const session of this.sessions.values()) {
            if (session.busy > 0) {
                continue;
            }
            if (!oldest || session.lastActivity < oldest.lastActivity) {
                oldest = session;
            }
        }
        if (oldest) {
            void this.drop(oldest);
        }
    }

    private async drop(session: LiveSession): Promise<void> {
        this.sessions.delete(session.id);
        try {
            await session.client.shutdown();
        } catch {
            /* already dead */
        }
    }

    private async onSession<T>(session: LiveSession, fn: () => Promise<T>): Promise<T> {
        const previous = session.queue;
        let release: () => void = () => undefined;
        session.queue = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await fn();
        } finally {
            release();
        }
    }

    private async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
        const previous = this.chain;
        let release: () => void = () => undefined;
        this.chain = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await fn();
        } finally {
            release();
        }
    }
}

function emptyPrompt(): PreparedPrompt {
    return { text: '', images: [], limitations: [], send: false };
}

interface Reservation {
    session: LiveSession;
    mode: 'replay' | 'continuation' | 'restore' | 'duplicate';
    prepared: PreparedPrompt;
    restorePath?: string;
    restored: boolean;
}
