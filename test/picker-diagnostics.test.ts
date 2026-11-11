import assert from 'node:assert/strict';
import test from 'node:test';
import {
    describeBinaryPath,
    formatPickerDiagnostics,
    redactSecrets,
    type PickerDiagnosticInput,
} from '../src/picker-diagnostics.js';

test('binary path diagnostics keep the basename and drop the directory', () => {
    assert.deepEqual(describeBinaryPath('pi'), { kind: 'default', baseName: 'pi' });
    assert.deepEqual(describeBinaryPath('pi.cmd'), { kind: 'bare-name', baseName: 'pi.cmd' });
    assert.deepEqual(
        describeBinaryPath('C:\\Users\\someone\\Tools\\node\\pi.cmd'),
        { kind: 'absolute', baseName: 'pi.cmd' }
    );
    assert.deepEqual(
        describeBinaryPath('/home/someone/.local/bin/pi'),
        { kind: 'absolute', baseName: 'pi' }
    );
});

test('picker diagnostics list registered and selected models and omit secrets', () => {
    const secret = 'sk-live-secretvalue';
    const report = formatPickerDiagnostics(sample({
        registrationError: `failed near ${secret}`,
        additionalArgsCount: 2,
    }));
    assert.match(report, /^version: 0\.3\.3$/m);
    assert.match(report, /vscode\.version: 1\.144\.1/);
    assert.match(report, /id: anthropic:claude/);
    assert.match(report, /isUserSelectable: true/);
    assert.match(report, /targetChatSessionType: unset/);
    assert.match(report, /isBYOK: unset/);
    assert.match(report, /capabilities\.toolCalling: false/);
    assert.match(report, /selectChatModels\(\{ vendor: "pi" \}\) count: 1/);
    assert.match(report, /vendor pi: 1/);
    assert.match(report, /vendor copilot: 3/);
    assert.match(report, /piPresentInUnfilteredSelect: true/);
    assert.match(report, /pi\.binaryPath\.baseName: pi\.cmd/);
    assert.match(report, /pi\.additionalArgs\.count: 2/);
    assert.match(report, /chatModelVisibility/);
    assert.match(report, /picker UI was not executed/);
    assert.doesNotMatch(report, /Users\\someone/);
    assert.doesNotMatch(report, /sk-live/);
    assert.match(report, /\[redacted\]/);
    assert.doesNotMatch(report, /--api-key/);
});

test('secret-shaped substrings are redacted and ordinary paths are not', () => {
    assert.equal(redactSecrets('token sk-abcdefghijklmnopqrstuvwxyz'), 'token [redacted]');
    assert.match(redactSecrets('missing at C:\\Tools\\pi.cmd'), /C:\\Tools\\pi\.cmd/);
});

function sample(overrides: Partial<PickerDiagnosticInput>): PickerDiagnosticInput {
    return {
        generatedAt: '2026-11-11T00:00:00.000Z',
        extensionId: 'tintinweb.vscode-pi-model-chat-provider',
        extensionVersion: '0.3.3',
        publisher: 'tintinweb',
        enginesVscode: '^1.109.0',
        vscodeVersion: '1.144.1',
        enabledApiProposals: [],
        activationEvents: ['onLanguageModelChatProvider:pi', 'onCommand:pi.showModelPickerDiagnostics'],
        vendor: 'pi',
        vendorDisplayName: 'Pi Coding Agent',
        vendorWhen: undefined,
        workspaceTrusted: true,
        workspaceFolderCount: 1,
        binaryPathKind: 'absolute',
        binaryBaseName: 'pi.cmd',
        additionalArgsCount: 0,
        autoRestart: true,
        maxRestartAttempts: 3,
        commandTimeoutMs: 30000,
        hungRequestTimeoutMs: 0,
        shutdownGraceMs: 5000,
        persistSessions: false,
        sessionDirectorySet: false,
        workingDirectorySet: false,
        maxSessions: 20,
        sessionIdleTimeoutSeconds: 600,
        debug: false,
        chatAgentEnabled: true,
        chatEdits2Enabled: undefined,
        inlineChatEnableV2: undefined,
        probedPiVersion: '1.5.2',
        registrationError: undefined,
        registeredModels: [{
            id: 'anthropic:claude',
            name: 'pi /anthropic/claude',
            family: 'claude',
            version: 'claude',
            maxInputTokens: 200000,
            maxOutputTokens: 8192,
            toolCalling: false,
            imageInput: true,
            isUserSelectable: true,
            targetChatSessionType: undefined,
            isBYOK: undefined,
            category: undefined,
        }],
        selectVendorError: undefined,
        selectVendorModels: [{
            id: 'pi/anthropic:claude',
            name: 'pi /anthropic/claude',
            vendor: 'pi',
            family: 'claude',
            version: 'claude',
            maxInputTokens: 200000,
            toolCalling: false,
            imageInput: true,
        }],
        selectAllError: undefined,
        selectAllVendorCounts: [
            { vendor: 'copilot', count: 3 },
            { vendor: 'pi', count: 1 },
        ],
        piPresentInUnfilteredSelect: true,
        ...overrides,
    };
}
