import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { CancelToken } from '../src/cancel-token.js';
import type { PromptImage } from '../src/messages.js';
import type { PiEvent } from '../src/protocol/events.js';
import { SessionCoordinator, type TurnClient, type TurnModel, type TurnRequest } from '../src/session-coordinator.js';
import { SessionIndex } from '../src/session-index.js';
import { assistant, FakeToken, user, waitFor } from './helpers.js';

const model: TurnModel = { provider: 'anthropic', modelId: 'claude' };

class FakeClient implements TurnClient {
    prompts: string[] = [];
    images: PromptImage[][] = [];
    newSessions = 0;
    switched: string[] = [];
    alive = true;
    hold = false;
    failSwitch = false;
    lastText = 'answer';
    state: Record<string, unknown> = {};
    private readonly gates: Array<() => void> = [];

    ensureReady(): Promise<void> {
        return Promise.resolve();
    }

    newSession(): Promise<void> {
        this.newSessions++;
        return Promise.resolve();
    }

    switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
        this.switched.push(sessionPath);
        if (this.failSwitch) {
            return Promise.reject(new Error('switch failed'));
        }
        return Promise.resolve({ cancelled: false });
    }

    sendPrompt(options: {
        prompt: string;
        images?: PromptImage[];
        model: TurnModel;
        onEvent: (event: PiEvent) => void;
        token: CancelToken;
    }): Promise<void> {
        this.prompts.push(options.prompt);
        this.images.push(options.images ?? []);
        if (!this.hold) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.gates.push(resolve);
        });
    }

    release(): void {
        this.gates.shift()?.();
    }

    getLastAssistantText(): Promise<string | null> {
        return Promise.resolve(this.lastText);
    }

    getState(): Promise<Record<string, unknown>> {
        return Promise.resolve(this.state);
    }

    getSessionStats(): Promise<Record<string, unknown>> {
        return Promise.resolve({});
    }

    shutdown(): Promise<void> {
        this.alive = false;
        return Promise.resolve();
    }
}

function request(messages: TurnRequest['messages'], extra: Partial<TurnRequest> = {}): TurnRequest {
    return {
        messages,
        model,
        modelKey: 'anthropic:claude',
        cwd: '/work',
        token: new FakeToken(),
        onEvent() {
            /* empty */
        },
        ...extra,
    };
}

test('concurrent prompts on one transcript run in order on one process', async () => {
    const clients: FakeClient[] = [];
    const coordinator = new SessionCoordinator({
        createClient: () => {
            const client = new FakeClient();
            client.hold = true;
            clients.push(client);
            return client;
        },
        maxSessions: 4,
        idleTimeoutMs: 0,
    });
    try {
        const first = coordinator.run(request([user('one')]));
        await waitFor(() => clients[0]?.prompts.length === 1);
        const second = coordinator.run(request([
            user('one'),
            assistant('done'),
            user('two'),
        ]));
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(clients.length, 1);
        assert.equal(clients[0].prompts.length, 1);
        clients[0].release();
        await first;
        await waitFor(() => clients[0].prompts.length === 2);
        assert.match(clients[0].prompts[1], /two/);
        assert.equal(clients[0].prompts[1].includes('restored this chat'), false);
        clients[0].release();
        await second;
    } finally {
        await coordinator.dispose();
    }
});

test('an edited history forks onto a new process and replays the transcript', async () => {
    const clients: FakeClient[] = [];
    const coordinator = new SessionCoordinator({
        createClient: () => {
            const client = new FakeClient();
            clients.push(client);
            return client;
        },
        maxSessions: 4,
        idleTimeoutMs: 0,
    });
    try {
        await coordinator.run(request([user('hello')]));
        await coordinator.run(request([user('hello edited')]));
        assert.equal(clients.length, 2);
        assert.match(clients[1].prompts[0], /restored this chat/);
        assert.match(clients[1].prompts[0], /hello edited/);
        assert.equal(clients[1].newSessions, 1);
    } finally {
        await coordinator.dispose();
    }
});

test('a different model does not reuse the process', async () => {
    const clients: FakeClient[] = [];
    const coordinator = new SessionCoordinator({
        createClient: () => {
            const client = new FakeClient();
            clients.push(client);
            return client;
        },
        maxSessions: 4,
        idleTimeoutMs: 0,
    });
    try {
        await coordinator.run(request([user('hello')]));
        await coordinator.run(request([user('hello')], { modelKey: 'openai:gpt', model: { provider: 'openai', modelId: 'gpt' } }));
        assert.equal(clients.length, 2);
    } finally {
        await coordinator.dispose();
    }
});

test('idle sessions are shut down', async () => {
    let clock = 1_000;
    const clients: FakeClient[] = [];
    const coordinator = new SessionCoordinator({
        createClient: () => {
            const client = new FakeClient();
            clients.push(client);
            return client;
        },
        maxSessions: 4,
        idleTimeoutMs: 500,
        now: () => clock,
    });
    try {
        await coordinator.run(request([user('hello')]));
        clock += 5_000;
        coordinator.expireIdle();
        assert.equal(clients[0].alive, false);
        assert.equal(coordinator.size, 0);
    } finally {
        await coordinator.dispose();
    }
});

test('opt-in index restores a session file and does not keep paths outside the directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-index-'));
    try {
        const index = new SessionIndex(dir);
        const sessionFile = path.join(dir, 'mock-session.jsonl');
        await writeFile(sessionFile, '{}\n');
        const outside = path.join(tmpdir(), `not-in-workspace-${Date.now()}.jsonl`);
        await writeFile(outside, '{}\n');
        index.set('secret', outside);
        assert.equal(index.get('secret'), undefined);
        await rm(outside, { force: true });

        const firstClients: FakeClient[] = [];
        const first = new SessionCoordinator({
            createClient: () => {
                const client = new FakeClient();
                client.state = { sessionFile };
                firstClients.push(client);
                return client;
            },
            maxSessions: 2,
            idleTimeoutMs: 0,
            index,
        });
        await first.run(request([user('hi')]));
        await first.dispose();

        const secondClients: FakeClient[] = [];
        const second = new SessionCoordinator({
            createClient: () => {
                const client = new FakeClient();
                secondClients.push(client);
                return client;
            },
            maxSessions: 2,
            idleTimeoutMs: 0,
            index,
        });
        const outcome = await second.run(request([
            user('hi'),
            assistant('there'),
            user('next'),
        ]));
        assert.equal(secondClients[0].switched[0], sessionFile);
        assert.equal(secondClients[0].newSessions, 0);
        assert.match(secondClients[0].prompts[0], /next/);
        assert.equal(secondClients[0].prompts[0].includes('restored this chat'), false);
        assert.equal(outcome.restored, true);
        await second.dispose();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
