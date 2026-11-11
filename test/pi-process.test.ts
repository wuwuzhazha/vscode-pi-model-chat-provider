import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { PiCancelledError, PiHungError } from '../src/errors.js';
import { applyAgentEvent, createStreamState } from '../src/render.js';
import { PiProcess, type SpawnImpl } from '../src/pi-process.js';
import { resolveHostToolTurn, TOOL_MODE_AUTO, TOOL_MODE_REQUIRED } from '../src/tool-policy.js';
import type { ExtensionUiRequest, PiUi } from '../src/ui-protocol.js';
import { FakeToken, installMockBinary, makeWorkspace, memoryLogger, repoRoot, testConfig, waitFor } from './helpers.js';

function scriptedUi(choice: 'allow' | 'deny' | 'cancel' = 'allow'): PiUi & { confirms: ExtensionUiRequest[] } {
    const confirms: ExtensionUiRequest[] = [];
    return {
        confirms,
        confirm: async (request) => {
            confirms.push(request);
            if (choice === 'allow') {
                return { kind: 'confirm', confirmed: true };
            }
            if (choice === 'deny') {
                return { kind: 'confirm', confirmed: false };
            }
            return { kind: 'cancel' };
        },
        select: async () => ({ kind: 'cancel' }),
        input: async () => ({ kind: 'cancel' }),
        editor: async () => ({ kind: 'cancel' }),
        notify() {
            /* empty */
        },
        setStatus() {
            /* empty */
        },
        setWidget() {
            /* empty */
        },
        setTitle() {
            /* empty */
        },
        setEditorText() {
            /* empty */
        },
    };
}

async function createHarness(env: Record<string, string>, overrides: Parameters<typeof testConfig>[2] = {}) {
    const dir = await makeWorkspace();
    const binary = await installMockBinary(dir);
    const logPath = path.join(dir, 'pi.log');
    const proc = new PiProcess(
        testConfig(dir, binary, overrides),
        scriptedUi(),
        memoryLogger(),
        () => true,
        undefined,
        { ...process.env, MOCK_PI_LOG: logPath, ...env }
    );
    return {
        dir,
        proc,
        logPath,
        async log() {
            try {
                return await readFile(logPath, 'utf8');
            } catch {
                return '';
            }
        },
        async cleanup() {
            await proc.shutdown().catch(() => undefined);
            await rm(dir, { recursive: true, force: true });
        },
    };
}

test('strict framing round-trips a record that contains unicode separators', async () => {
    const harness = await createHarness({ MOCK_PI_SCENARIO: 'unicode' });
    try {
        const state = await harness.proc.getState();
        assert.equal(state.note, 'A\u2028B\u2029C');
    } finally {
        await harness.cleanup();
    }
});

test('settled completion waits past an early agent_end', async () => {
    const harness = await createHarness({
        MOCK_PI_SCENARIO: 'happy',
        MOCK_PI_SETTLE_DELAY_MS: '350',
    });
    try {
        const events: string[] = [];
        let endAt = 0;
        await harness.proc.newSession();
        await harness.proc.sendPrompt({
            prompt: 'hello',
            model: { provider: 'anthropic', modelId: 'claude-sonnet' },
            token: new FakeToken(),
            onEvent: (event) => {
                events.push(event.type);
                if (event.type === 'agent_end') {
                    endAt = Date.now();
                }
            },
        });
        const waited = Date.now() - endAt;
        assert.ok(events.indexOf('agent_end') < events.indexOf('agent_settled'));
        assert.ok(waited >= 200, `returned ${waited}ms after agent_end`);
        const text = await harness.proc.getLastAssistantText();
        assert.equal(text, 'hello from pi');
        const log = await harness.log();
        assert.match(log, /--no-session/);
        assert.equal(log.includes('--session-dir'), false);
        assert.ok(log.indexOf('event agent_settled') < log.indexOf('cmd get_last_assistant_text'));
    } finally {
        await harness.cleanup();
    }
});

test('a handled prompt does not wait for agent_settled', async () => {
    const harness = await createHarness({ MOCK_PI_SCENARIO: 'handled' });
    try {
        const started = Date.now();
        await harness.proc.sendPrompt({
            prompt: '/command',
            model: { provider: 'anthropic', modelId: 'claude-sonnet' },
            token: new FakeToken(),
            onEvent() {
                /* empty */
            },
        });
        assert.ok(Date.now() - started < 1500);
        const log = await harness.log();
        assert.equal(log.includes('agent_settled'), false);
    } finally {
        await harness.cleanup();
    }
});

test('Pi before agent_settled completes on agent_end', async () => {
    const harness = await createHarness({
        MOCK_PI_VERSION: '0.79.0',
        MOCK_PI_SCENARIO: 'legacy',
    });
    try {
        await harness.proc.sendPrompt({
            prompt: 'hello',
            model: { provider: 'anthropic', modelId: 'claude-sonnet' },
            token: new FakeToken(),
            onEvent() {
                /* empty */
            },
        });
        const log = await harness.log();
        assert.match(log, /event agent_end/);
        assert.equal(log.includes('agent_settled'), false);
        assert.match(harness.proc.capabilities?.version.raw ?? '', /0\.79\.0/);
    } finally {
        await harness.cleanup();
    }
});

test('cancellation clears the queue before abort on Pi that supports it', async () => {
    const harness = await createHarness({ MOCK_PI_SCENARIO: 'cancel', MOCK_PI_VERSION: '1.5.2' });
    try {
        const token = new FakeToken();
        const pending = harness.proc.sendPrompt({
            prompt: 'hello',
            model: { provider: 'anthropic', modelId: 'claude-sonnet' },
            token,
            onEvent() {
                /* empty */
            },
        });
        await waitFor(async () => (await harness.log()).includes('prompt-accepted'));
        token.cancel();
        await assert.rejects(async () => {
            await pending;
        }, PiCancelledError);
        const log = await harness.log();
        assert.ok(log.indexOf('cmd clear_queue') < log.indexOf('cmd abort'));
    } finally {
        await harness.cleanup();
    }
});

test('cancellation on Pi 0.80 aborts without clear_queue', async () => {
    const harness = await createHarness({ MOCK_PI_SCENARIO: 'cancel', MOCK_PI_VERSION: '0.80.4' });
    try {
        const token = new FakeToken();
        const pending = harness.proc.sendPrompt({
            prompt: 'hello',
            model: { provider: 'anthropic', modelId: 'claude-sonnet' },
            token,
            onEvent() {
                /* empty */
            },
        });
        await waitFor(async () => (await harness.log()).includes('prompt-accepted'));
        token.cancel();
        await assert.rejects(async () => {
            await pending;
        }, PiCancelledError);
        const log = await harness.log();
        assert.match(log, /cmd abort/);
        assert.equal(log.includes('cmd clear_queue'), false);
    } finally {
        await harness.cleanup();
    }
});

test('a hung prompt is aborted after the inactivity timeout', async () => {
    const harness = await createHarness(
        { MOCK_PI_SCENARIO: 'silent' },
        { hungRequestTimeoutMs: 200, shutdownGraceMs: 200, commandTimeoutMs: 1000 }
    );
    try {
        await assert.rejects(
            harness.proc.sendPrompt({
                prompt: 'hello',
                model: { provider: 'anthropic', modelId: 'claude-sonnet' },
                token: new FakeToken(),
                onEvent() {
                    /* empty */
                },
            }),
            (error: unknown) => error instanceof PiHungError && /hungRequestTimeoutMs/.test(error.message)
        );
        assert.equal(harness.proc.alive, false);
    } finally {
        await harness.cleanup();
    }
});

test('a crashed process surfaces stderr', async () => {
    const harness = await createHarness({ MOCK_PI_SCENARIO: 'crash' });
    try {
        await assert.rejects(
            harness.proc.sendPrompt({
                prompt: 'hello',
                model: { provider: 'anthropic', modelId: 'claude-sonnet' },
                token: new FakeToken(),
                onEvent() {
                    /* empty */
                },
            }),
            /model exploded/
        );
    } finally {
        await harness.cleanup();
    }
});

test('dismissing a confirm dialog sends cancelled rather than deny', async () => {
    const dir = await makeWorkspace();
    const binary = await installMockBinary(dir);
    const logPath = path.join(dir, 'pi.log');
    const ui = scriptedUi('cancel');
    const proc = new PiProcess(
        testConfig(dir, binary),
        ui,
        memoryLogger(),
        () => true,
        undefined,
        { ...process.env, MOCK_PI_LOG: logPath, MOCK_PI_SCENARIO: 'ui', MOCK_PI_SETTLE_DELAY_MS: '0' }
    );
    try {
        await proc.sendPrompt({
            prompt: 'hello',
            model: { provider: 'anthropic', modelId: 'claude-sonnet' },
            token: new FakeToken(),
            onEvent() {
                /* empty */
            },
        });
        const log = await readFile(logPath, 'utf8');
        assert.match(log, /"cancelled":true/);
        assert.equal(log.includes('"confirmed":false'), false);
        assert.equal(ui.confirms.length, 1);
    } finally {
        await proc.shutdown().catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
    }
});

test('missing and outdated Pi produce actionable errors', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-missing-'));
    const missing = new PiProcess(
        testConfig(dir, path.join(dir, 'no-such-pi')),
        scriptedUi(),
        memoryLogger(),
        () => true
    );
    await assert.rejects(missing.ensureReady(), /not found|Install the CLI|npm install -g @earendil-works\/pi-coding-agent/);

    const harness = await createHarness({ MOCK_PI_VERSION: '0.73.0' });
    try {
        await assert.rejects(harness.proc.ensureReady(), /older than 0\.74\.0/);
        const log = await harness.log();
        assert.match(log, /--version/);
        assert.equal(log.includes('--mode'), false);
    } finally {
        await harness.cleanup();
        await rm(dir, { recursive: true, force: true });
    }
});

test('untrusted workspaces and unsafe session args do not spawn Pi', async () => {
    const calls: string[][] = [];
    const spawnImpl: SpawnImpl = (command, args) => {
        calls.push([command, ...args]);
        throw new Error('spawn should not be called');
    };
    const dir = await makeWorkspace();
    try {
        const untrusted = new PiProcess(
            testConfig(dir, 'pi'),
            scriptedUi(),
            memoryLogger(),
            () => false,
            spawnImpl
        );
        await assert.rejects(untrusted.ensureReady(), /not trusted/);

        const unsafe = new PiProcess(
            testConfig(dir, 'pi', { additionalArgs: ['--session-dir', '/tmp/outside'] }),
            scriptedUi(),
            memoryLogger(),
            () => true,
            spawnImpl
        );
        await assert.rejects(unsafe.ensureReady(), /additionalArgs/);
        assert.equal(calls.length, 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('persistence passes a workspace session directory and not --no-session', async () => {
    const dir = await makeWorkspace();
    const sessionDir = path.join(dir, '.pi', 'vscode-lm-sessions');
    const harness = await createHarness({}, { sessionDir, persistSessions: true, cwd: dir });
    try {
        await harness.proc.getState();
        const log = await harness.log();
        assert.match(log, /--session-dir/);
        assert.equal(log.includes('--no-session'), false);
        const state = await harness.proc.getState();
        assert.equal(typeof state.sessionFile, 'string');
        assert.match(String(state.sessionFile), /mock-session\.jsonl/);
    } finally {
        await harness.cleanup();
    }
});

test('mocked Windows: version probe and RPC spawn the same node.exe and cli.js', async () => {
    const root = 'C:\\Program Files\\node-v24\\';
    const nodeExe = `${root}node.exe`;
    const cmd = `${root}pi.cmd`;
    const script = `${root}node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js`;
    const shim = [
        '@ECHO off',
        'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
        '"%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
    ].join('\r\n');
    const known = new Map<string, string | true>([
        [nodeExe.toLowerCase(), true],
        [cmd.toLowerCase(), shim],
        [script.toLowerCase(), true],
    ]);
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnImpl: SpawnImpl = (command, args) => {
        calls.push({ command, args: [...args] });
        return args.includes('--version') ? versionChild() : rpcChild();
    };
    const proc = new PiProcess(
        testConfig('C:\\work', 'pi', { cwd: 'C:\\work' }),
        scriptedUi(),
        memoryLogger(),
        () => true,
        spawnImpl,
        { Path: root },
        'win32',
        {
            exists: (filePath) => known.has(filePath.toLowerCase()),
            read: (filePath) => {
                const value = known.get(filePath.toLowerCase());
                return typeof value === 'string' ? { text: value, head: value.slice(0, 2) } : undefined;
            },
        }
    );
    await proc.ensureReady();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, nodeExe);
    assert.deepEqual(calls[0].args.slice(0, 2), [script, '--version']);
    assert.equal(calls[1].command, nodeExe);
    assert.equal(calls[1].args[0], script);
    assert.deepEqual(calls[1].args.slice(1, 3), ['--mode', 'rpc']);
    assert.equal(calls.some((call) => call.command.toLowerCase().endsWith('cmd.exe')), false);
    await proc.shutdown();
});

function versionChild(): ChildProcess {
    const child = fakeProcess();
    queueMicrotask(() => {
        child.emit('spawn');
        child.stdout?.emit('data', Buffer.from('1.5.2\n'));
        Object.assign(child, { exitCode: 0 });
        child.emit('exit', 0, null);
    });
    return child;
}

function rpcChild(): ChildProcess {
    const child = fakeProcess();
    let buffer = '';
    const stdin = child.stdin as unknown as { write: (chunk: string) => boolean; end: () => void };
    stdin.write = (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            const message = JSON.parse(line) as { id?: string; type?: string };
            if (message.type === 'get_state') {
                child.stdout?.emit('data', Buffer.from(JSON.stringify({
                    type: 'response',
                    id: message.id,
                    command: 'get_state',
                    success: true,
                    data: { note: 'ok' },
                }) + '\n'));
            }
            newline = buffer.indexOf('\n');
        }
        return true;
    };
    stdin.end = () => undefined;
    queueMicrotask(() => child.emit('spawn'));
    return child;
}

function fakeProcess(): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    child.stdout = new EventEmitter() as ChildProcess['stdout'];
    child.stderr = new EventEmitter() as ChildProcess['stderr'];
    child.stdin = new EventEmitter() as ChildProcess['stdin'];
    Object.assign(child, { killed: false, exitCode: null, pid: 4242 });
    child.kill = () => {
        Object.assign(child, { killed: true, exitCode: 0 });
        child.emit('exit', 0, null);
        return true;
    };
    return child;
}

test('mock host tool request is forwarded once and the continuation does not call it again', async () => {
    const harness = await createHarness({
        MOCK_PI_SCENARIO: 'host-tool',
        MOCK_PI_SETTLE_DELAY_MS: '20',
    });
    try {
        await harness.proc.newSession();
        const first = createStreamState();
        await harness.proc.sendPrompt({
            prompt: 'read the file',
            model: { provider: 'magpie', modelId: 'auto/deepseek-v4.1-flash' },
            token: new FakeToken(),
            onEvent: (event) => {
                applyAgentEvent(event, first);
            },
        });
        const required = resolveHostToolTurn({
            toolMode: TOOL_MODE_REQUIRED,
            offered: [{ name: 'read_file' }],
            priorCallIds: new Set(),
            requested: first.hostToolRequests,
            executedByPi: first.piExecutedTools,
        });
        assert.deepEqual(required.calls, [{
            callId: 'call-1',
            name: 'read_file',
            input: { path: 'src/a.ts' },
        }]);
        assert.equal(first.piExecutedTools.length, 0);

        const second = createStreamState();
        await harness.proc.sendPrompt({
            prompt: '[VS Code tool result call-1 — already executed by VS Code; do not run it again]\nfile contents',
            model: { provider: 'magpie', modelId: 'auto/deepseek-v4.1-flash' },
            token: new FakeToken(),
            onEvent: (event) => {
                applyAgentEvent(event, second);
            },
        });
        const auto = resolveHostToolTurn({
            toolMode: TOOL_MODE_AUTO,
            offered: [{ name: 'read_file' }],
            priorCallIds: new Set(required.calls.map((call) => call.callId)),
            requested: second.hostToolRequests,
            executedByPi: second.piExecutedTools,
        });
        assert.equal(auto.calls.length, 0);
        assert.equal(second.streamedText, true);
        assert.equal(auto.error, undefined);
    } finally {
        await harness.cleanup();
    }
});

test('a host tool Pi already started is not forwarded', async () => {
    const harness = await createHarness({
        MOCK_PI_SCENARIO: 'host-tool-ran',
        MOCK_PI_SETTLE_DELAY_MS: '20',
    });
    try {
        await harness.proc.newSession();
        const state = createStreamState();
        await harness.proc.sendPrompt({
            prompt: 'read',
            model: { provider: 'magpie', modelId: 'auto/deepseek-v4.1-flash' },
            token: new FakeToken(),
            onEvent: (event) => {
                applyAgentEvent(event, state);
            },
        });
        const decision = resolveHostToolTurn({
            toolMode: TOOL_MODE_REQUIRED,
            offered: [{ name: 'read_file' }],
            priorCallIds: new Set(),
            requested: state.hostToolRequests,
            executedByPi: state.piExecutedTools,
        });
        assert.equal(decision.calls.length, 0);
        assert.match(decision.error ?? '', /does not invent a call/);
        assert.match(decision.notices.join('\n'), /not sent to VS Code/);
    } finally {
        await harness.cleanup();
    }
});

test('provider emits host tool-call parts only through the turn decision and is not a chat participant', async () => {
    const source = await readFile(path.join(repoRoot(), 'src', 'provider.ts'), 'utf8');
    const render = await readFile(path.join(repoRoot(), 'src', 'render.ts'), 'utf8');
    assert.match(source, /new vscode\.LanguageModelToolCallPart/);
    assert.match(source, /resolveHostToolTurn/);
    assert.equal(source.includes('createChatParticipant'), false);
    assert.equal(source.includes('registerChatParticipant'), false);
    assert.equal(render.includes('LanguageModelToolCallPart'), false);
});
