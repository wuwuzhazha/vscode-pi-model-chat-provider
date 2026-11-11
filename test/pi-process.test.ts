import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { PiCancelledError, PiHungError } from '../src/errors.js';
import { PiProcess, type SpawnImpl } from '../src/pi-process.js';
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

test('provider source does not construct host tool-call parts or a chat participant', async () => {
    const source = await readFile(path.join(repoRoot(), 'src', 'provider.ts'), 'utf8');
    assert.equal(source.includes('new vscode.LanguageModelToolCallPart'), false);
    assert.equal(source.includes('createChatParticipant'), false);
    assert.equal(source.includes('registerChatParticipant'), false);
    assert.match(source, /toolCalling: false|modelCapabilities\(\)/);
});
