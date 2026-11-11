import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRegisteredModelId, stripVendorPrefix } from '../src/model-id.js';
import {
    AGENT_SETTLED_VERSION,
    capabilitiesFor,
    CLEAR_QUEUE_VERSION,
    compareSemver,
    MIN_PI_VERSION,
    parseSemver,
} from '../src/protocol/version.js';
import { decideHostTools, modelCapabilities } from '../src/tool-policy.js';
import { dialogToResponse, mapConfirmChoice, mapValueChoice } from '../src/ui-protocol.js';
import { resolveSessionDirectory, resolveWorkingDirectory } from '../src/workspace-policy.js';
import { applyAgentEvent, createStreamState } from '../src/render.js';

test('parse versions and capability thresholds from the Pi changelog', () => {
    const parsed = parseSemver('pi 1.5.2\n');
    assert.equal(parsed?.raw, '1.5.2');
    assert.equal(parseSemver('nope'), undefined);
    assert.ok(compareSemver(parseSemver('0.73.9')!, MIN_PI_VERSION) < 0);
    assert.equal(capabilitiesFor(parseSemver('0.79.0')!).agentSettled, false);
    assert.equal(capabilitiesFor(AGENT_SETTLED_VERSION).agentSettled, true);
    assert.equal(capabilitiesFor(parseSemver('0.84.3')!).clearQueue, false);
    assert.equal(capabilitiesFor(CLEAR_QUEUE_VERSION).clearQueue, true);
    assert.equal(capabilitiesFor(parseSemver('1.5.2')!).clearQueue, true);
});

test('vendor prefix stripping keeps slashes that belong to the model id', () => {
    assert.equal(
        stripVendorPrefix('pi/openrouter:anthropic/claude-3.5-sonnet'),
        'openrouter:anthropic/claude-3.5-sonnet'
    );
    const providers = new Map([['openrouter:anthropic/claude-3.5-sonnet', 'openrouter']]);
    const parsed = parseRegisteredModelId('pi/openrouter:anthropic/claude-3.5-sonnet', providers);
    assert.equal(parsed.provider, 'openrouter');
    assert.equal(parsed.modelId, 'anthropic/claude-3.5-sonnet');
});

test('host tool capability is false and required mode fails visibly', () => {
    assert.equal(modelCapabilities().toolCalling, false);
    assert.equal(decideHostTools(1, 0).notice, undefined);
    assert.match(decideHostTools(1, 2).notice ?? '', /does not call them/);
    assert.throws(() => decideHostTools(2, 1), /toolMode Required/);
});

test('closing a dialog is cancelled and is distinct from deny', () => {
    assert.deepEqual(mapConfirmChoice(undefined), { kind: 'cancel' });
    assert.deepEqual(mapConfirmChoice('Deny'), { kind: 'confirm', confirmed: false });
    assert.deepEqual(mapConfirmChoice('Allow'), { kind: 'confirm', confirmed: true });
    assert.deepEqual(dialogToResponse('1', { kind: 'cancel' }), {
        type: 'extension_ui_response',
        id: '1',
        cancelled: true,
    });
    assert.deepEqual(dialogToResponse('2', { kind: 'confirm', confirmed: false }), {
        type: 'extension_ui_response',
        id: '2',
        confirmed: false,
    });
    assert.equal(dialogToResponse('3', mapValueChoice(undefined, true)), undefined);
    assert.deepEqual(dialogToResponse('4', mapValueChoice('', false)), {
        type: 'extension_ui_response',
        id: '4',
        value: '',
    });
});

test('tool events become text and do not look like host tool calls', () => {
    const state = createStreamState();
    const chunks = applyAgentEvent({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'ls' },
    }, state);
    assert.equal(chunks.length, 1);
    assert.match(chunks[0], /pi tool bash/);
    assert.match(chunks[0], /not a VS Code tool call/);
    const result = applyAgentEvent({
        type: 'tool_execution_end',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'ok' }, { type: 'image', mimeType: 'image/png' }] },
    }, state);
    assert.match(result.join('\n'), /image\/png/);
    assert.equal(state.reportedToolActivity, true);
});

test('session directory stays inside the workspace unless persistence is off', () => {
    assert.equal(resolveSessionDirectory({
        persist: false,
        configuredDir: '/tmp/outside',
        workspaceFolders: ['/work/app'],
    }), undefined);
    assert.equal(resolveSessionDirectory({
        persist: true,
        configuredDir: '',
        workspaceFolders: ['/work/app'],
    }), '/work/app/.pi/vscode-lm-sessions');
    assert.throws(() => resolveSessionDirectory({
        persist: true,
        configuredDir: '/tmp/outside',
        workspaceFolders: ['/work/app'],
    }), /outside the workspace/);
    assert.equal(resolveWorkingDirectory('', ['/work/app']), '/work/app');
    assert.throws(() => resolveWorkingDirectory('', []), /No workspace folder/);
});
