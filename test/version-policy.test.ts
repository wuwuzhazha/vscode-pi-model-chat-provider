import assert from 'node:assert/strict';
import * as path from 'node:path';
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
import { modelCapabilities, resolveHostToolTurn, TOOL_MODE_AUTO, TOOL_MODE_REQUIRED, visibleInChatModelPicker } from '../src/tool-policy.js';
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

test('host tool calls are forwarded only when Pi asked and did not already start the tool', () => {
    assert.equal(modelCapabilities().toolCalling, true);
    const offered = [{ name: 'read_file' }];
    const request = { callId: 'call-1', name: 'read_file', input: { path: 'src/a.ts' } };
    const forwarded = resolveHostToolTurn({
        toolMode: TOOL_MODE_REQUIRED,
        offered,
        priorCallIds: new Set(),
        requested: [request],
        executedByPi: [],
    });
    assert.deepEqual(forwarded.calls, [request]);
    assert.equal(forwarded.error, undefined);

    const again = resolveHostToolTurn({
        toolMode: TOOL_MODE_AUTO,
        offered,
        priorCallIds: new Set(['call-1']),
        requested: [request],
        executedByPi: [],
    });
    assert.equal(again.calls.length, 0);
    assert.match(again.notices.join('\n'), /already sent/);

    const ranInsidePi = resolveHostToolTurn({
        toolMode: TOOL_MODE_REQUIRED,
        offered,
        priorCallIds: new Set(),
        requested: [request],
        executedByPi: ['read_file'],
    });
    assert.equal(ranInsidePi.calls.length, 0);
    assert.match(ranInsidePi.error ?? '', /does not invent a call/);

    const autoText = resolveHostToolTurn({
        toolMode: TOOL_MODE_AUTO,
        offered,
        priorCallIds: new Set(),
        requested: [],
        executedByPi: ['bash'],
    });
    assert.equal(autoText.calls.length, 0);
    assert.match(autoText.notices.join('\n'), /none were called/);
});

test('transcribed 1.144.1 filter keeps Local Ask and drops Agent, a foreign pool, and a hidden id', () => {
    const pi = {
        isUserSelectable: true as boolean | undefined,
        toolCalling: false,
        edits2Enabled: false,
        inlineChatV2: false,
        sessionHasOwnModelPool: false,
    };
    assert.equal(visibleInChatModelPicker({ ...pi, mode: 'ask', sessionType: 'local' }), true);
    assert.equal(visibleInChatModelPicker({ ...pi, mode: 'ask', sessionType: 'local', hidden: true }), false);
    assert.equal(visibleInChatModelPicker({ ...pi, mode: 'ask', sessionType: undefined }), true);
    assert.equal(visibleInChatModelPicker({ ...pi, mode: 'agent', sessionType: 'local' }), false);
    assert.equal(visibleInChatModelPicker({
        ...pi,
        mode: 'ask',
        sessionType: 'agent-host-copilotcli',
        sessionHasOwnModelPool: true,
    }), false);
    assert.equal(visibleInChatModelPicker({ ...pi, isUserSelectable: false, mode: 'ask', sessionType: 'local' }), false);
    assert.equal(visibleInChatModelPicker({
        ...pi,
        mode: 'agent',
        toolCalling: true,
        sessionType: 'local',
    }), true);
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
    }), path.join('/work/app', '.pi', 'vscode-lm-sessions'));
    assert.throws(() => resolveSessionDirectory({
        persist: true,
        configuredDir: '/tmp/outside',
        workspaceFolders: ['/work/app'],
    }), /outside the workspace/);
    assert.equal(resolveWorkingDirectory('', ['/work/app']), '/work/app');
    assert.throws(() => resolveWorkingDirectory('', []), /No workspace folder/);
});
