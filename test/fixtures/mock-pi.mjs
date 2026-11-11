/**
 * Deterministic Pi RPC stand-in. No network and no model calls.
 * Scenarios are selected with MOCK_PI_SCENARIO.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
const version = process.env.MOCK_PI_VERSION || '1.5.2';
const scenario = process.env.MOCK_PI_SCENARIO || 'happy';
const logPath = process.env.MOCK_PI_LOG;
const settleDelay = Number(process.env.MOCK_PI_SETTLE_DELAY_MS || '350');

function log(line) {
    if (!logPath) {
        return;
    }
    fs.appendFileSync(logPath, `${line}\n`);
}

log(`argv ${args.join(' ')}`);

if (args.includes('--version')) {
    process.stdout.write(`${version}\n`);
    process.exit(0);
}

let sessionDir;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-dir') {
        sessionDir = args[i + 1];
    }
}
const sessionFile = sessionDir ? path.join(sessionDir, 'mock-session.jsonl') : undefined;
if (sessionFile) {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionFile, '{"type":"session"}\n');
}

const pendingUi = new Map();
let chain = Promise.resolve();
let buffer = Buffer.alloc(0);

function writeObject(value) {
    const line = `${JSON.stringify(value)}\n`;
    if (scenario === 'unicode' && value.command === 'get_state') {
        const bytes = Buffer.from(line, 'utf8');
        const mid = Math.max(1, Math.floor(bytes.length / 2));
        process.stdout.write(bytes.subarray(0, mid));
        process.stdout.write(bytes.subarray(mid));
        return;
    }
    process.stdout.write(line);
}

function reply(id, command, data, success = true, error) {
    writeObject({
        type: 'response',
        id,
        command,
        success,
        ...(success ? { data } : { error: error || 'failed' }),
    });
}

function emit(event) {
    log(`event ${event.type}`);
    writeObject(event);
}

async function waitForUi(id, request) {
    writeObject({ type: 'extension_ui_request', id, ...request });
    return new Promise((resolve) => {
        pendingUi.set(id, resolve);
    });
}

async function handle(message) {
    const id = message.id;
    const type = message.type;
    log(`cmd ${type}`);
    if (type === 'get_state') {
        reply(id, 'get_state', {
            note: scenario === 'unicode' ? 'A\u2028B\u2029C' : 'ok',
            sessionFile: sessionFile ?? null,
            model: { contextWindow: 200000 },
        });
        return;
    }
    if (type === 'get_available_models') {
        reply(id, 'get_available_models', {
            models: [{
                provider: 'anthropic',
                id: 'claude-sonnet',
                contextWindow: 200000,
                maxTokens: 8192,
            }],
        });
        return;
    }
    if (type === 'set_model' || type === 'new_session' || type === 'switch_session') {
        reply(id, type, type === 'set_model'
            ? { provider: message.provider, id: message.modelId }
            : { cancelled: false });
        return;
    }
    if (type === 'get_last_assistant_text') {
        reply(id, type, { text: 'hello from pi' });
        return;
    }
    if (type === 'get_session_stats') {
        reply(id, type, { tokens: { total: 10, input: 8, output: 2, cacheRead: 0 }, cost: 0.01 });
        return;
    }
    if (type === 'clear_queue') {
        reply(id, type, { steering: [], followUp: [] });
        return;
    }
    if (type === 'abort') {
        reply(id, type, undefined);
        if (scenario === 'cancel' || scenario === 'silent') {
            if (scenario === 'cancel') {
                emit({ type: 'agent_settled', aborted: true });
            }
        }
        return;
    }
    if (type !== 'prompt') {
        reply(id, type, undefined, false, `unknown command ${type}`);
        return;
    }

    if (scenario === 'handled') {
        reply(id, 'prompt', { disposition: 'handled' });
        log('prompt-accepted');
        return;
    }

    reply(id, 'prompt', { disposition: 'started' });
    log('prompt-accepted');

    if (scenario === 'crash') {
        process.stderr.write('model exploded\n');
        process.exit(1);
    }
    if (scenario === 'silent' || scenario === 'cancel') {
        return;
    }
    if (scenario === 'ui') {
        const response = await waitForUi('ui-1', {
            method: 'confirm',
            title: 'Run command?',
            message: 'rm -rf',
        });
        log(`ui ${JSON.stringify(response)}`);
    }
    if (scenario === 'legacy') {
        emit({ type: 'agent_end' });
        return;
    }
    emit({ type: 'agent_start' });
    emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'partial ' },
    });
    emit({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'pwd' },
    });
    emit({
        type: 'tool_execution_end',
        toolName: 'bash',
        isError: false,
        result: { content: [{ type: 'text', text: '/work' }, { type: 'image', mimeType: 'image/png' }] },
    });
    emit({ type: 'agent_end' });
    await new Promise((resolve) => setTimeout(resolve, settleDelay));
    emit({ type: 'agent_settled' });
}

process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] !== 0x0a) {
            continue;
        }
        const line = buffer.subarray(start, i).toString('utf8').replace(/\r$/, '');
        start = i + 1;
        if (!line.trim()) {
            continue;
        }
        const message = JSON.parse(line);
        if (message.type === 'extension_ui_response') {
            pendingUi.get(message.id)?.(message);
            continue;
        }
        chain = chain.then(() => handle(message), () => handle(message));
    }
    buffer = buffer.subarray(start);
});
