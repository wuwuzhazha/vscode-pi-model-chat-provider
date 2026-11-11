/**
 * Text report for the chat model picker. The workbench does not expose the
 * picker filters, so this report is limited to data the extension itself
 * holds and to the stable `vscode.lm.selectChatModels` result.
 * It never includes prompt text, API keys, environment variables, or
 * `pi.additionalArgs` values.
 */

export interface RegisteredModelRecord {
    readonly id: string;
    readonly name: string;
    readonly family: string;
    readonly version: string;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly toolCalling: boolean;
    readonly imageInput: boolean;
    /** Value this extension put on the object it returned. Undefined means the field was omitted. */
    readonly isUserSelectable: boolean | undefined;
    readonly targetChatSessionType: string | undefined;
    readonly isBYOK: boolean | undefined;
    readonly category: string | undefined;
}

export interface SelectChatModelObservation {
    readonly id: string;
    readonly name: string;
    readonly vendor: string;
    readonly family: string;
    readonly version: string;
    readonly maxInputTokens: number;
    readonly toolCalling: boolean | undefined;
    readonly imageInput: boolean | undefined;
}

export interface VendorCount {
    readonly vendor: string;
    readonly count: number;
}

export type BinaryPathKind = 'default' | 'bare-name' | 'absolute' | 'relative';

export interface PickerDiagnosticInput {
    readonly generatedAt: string;
    readonly extensionId: string;
    readonly extensionVersion: string;
    readonly publisher: string;
    readonly enginesVscode: string;
    readonly vscodeVersion: string;
    readonly enabledApiProposals: readonly string[];
    readonly activationEvents: readonly string[];
    readonly vendor: string;
    readonly vendorDisplayName: string;
    readonly vendorWhen: string | undefined;
    readonly workspaceTrusted: boolean;
    readonly workspaceFolderCount: number;
    readonly binaryPathKind: BinaryPathKind;
    readonly binaryBaseName: string;
    readonly additionalArgsCount: number;
    readonly autoRestart: boolean;
    readonly maxRestartAttempts: number;
    readonly commandTimeoutMs: number;
    readonly hungRequestTimeoutMs: number;
    readonly shutdownGraceMs: number;
    readonly persistSessions: boolean;
    readonly sessionDirectorySet: boolean;
    readonly workingDirectorySet: boolean;
    readonly maxSessions: number;
    readonly sessionIdleTimeoutSeconds: number;
    readonly debug: boolean;
    readonly chatAgentEnabled: boolean | undefined;
    readonly chatEdits2Enabled: boolean | undefined;
    readonly inlineChatEnableV2: boolean | undefined;
    readonly probedPiVersion: string | undefined;
    readonly registrationError: string | undefined;
    readonly registeredModels: readonly RegisteredModelRecord[];
    readonly selectVendorError: string | undefined;
    readonly selectVendorModels: readonly SelectChatModelObservation[];
    readonly selectAllError: string | undefined;
    readonly selectAllVendorCounts: readonly VendorCount[];
    readonly piPresentInUnfilteredSelect: boolean;
}

const SECRET = /(?:sk-|ghp_|github_pat_|xox[baprs]-|AKIA|Bearer\s+)[A-Za-z0-9_\-]{8,}/g;

/** Replace token-shaped substrings. Paths and ordinary error text stay. */
export function redactSecrets(text: string): string {
    return text.replace(SECRET, '[redacted]');
}

/**
 * Classify `pi.binaryPath` without returning the directory. A home-directory
 * path is personal; the basename is enough to tell `pi` from `pi.cmd`.
 */
export function describeBinaryPath(binaryPath: string): { kind: BinaryPathKind; baseName: string } {
    const trimmed = binaryPath.trim();
    const baseName = trimmed.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? '';
    if (trimmed === '' || trimmed === 'pi') {
        return { kind: 'default', baseName: baseName || 'pi' };
    }
    if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\\\')) {
        return { kind: 'absolute', baseName };
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
        return { kind: 'relative', baseName };
    }
    return { kind: 'bare-name', baseName };
}

export function formatPickerDiagnostics(input: PickerDiagnosticInput): string {
    const lines: string[] = [];
    const write = (line = '') => {
        lines.push(line);
    };
    write('Pi model picker diagnostics');
    write(`generatedAt: ${input.generatedAt}`);
    write('This report does not include prompt text, API keys, environment variables, or pi.additionalArgs values.');
    write('toolCalling is false in this extension. This report does not change it.');
    write('');
    write('Extension');
    write(`id: ${input.extensionId}`);
    write(`version: ${input.extensionVersion}`);
    write(`publisher: ${input.publisher}`);
    write(`engines.vscode: ${input.enginesVscode}`);
    write(`vscode.version: ${input.vscodeVersion}`);
    write(`enabledApiProposals: ${listOrNone(input.enabledApiProposals)}`);
    write(`activationEvents: ${listOrNone(input.activationEvents)}`);
    write(`languageModelChatProviders.vendor: ${input.vendor}`);
    write(`languageModelChatProviders.displayName: ${input.vendorDisplayName}`);
    write(`languageModelChatProviders.when: ${input.vendorWhen ?? 'unset'}`);
    write('');
    write('Preferences (non-secret)');
    write(`workspace.isTrusted: ${input.workspaceTrusted}`);
    write(`workspaceFolderCount: ${input.workspaceFolderCount}`);
    write(`pi.binaryPath.kind: ${input.binaryPathKind}`);
    write(`pi.binaryPath.baseName: ${input.binaryBaseName}`);
    write(`pi.additionalArgs.count: ${input.additionalArgsCount}`);
    write(`pi.autoRestart: ${input.autoRestart}`);
    write(`pi.maxRestartAttempts: ${input.maxRestartAttempts}`);
    write(`pi.commandTimeoutMs: ${input.commandTimeoutMs}`);
    write(`pi.hungRequestTimeoutMs: ${input.hungRequestTimeoutMs}`);
    write(`pi.shutdownGraceMs: ${input.shutdownGraceMs}`);
    write(`pi.persistSessions: ${input.persistSessions}`);
    write(`pi.sessionDirectory: ${input.sessionDirectorySet ? 'set' : 'empty'}`);
    write(`pi.workingDirectory: ${input.workingDirectorySet ? 'set' : 'empty'}`);
    write(`pi.maxSessions: ${input.maxSessions}`);
    write(`pi.sessionIdleTimeoutSeconds: ${input.sessionIdleTimeoutSeconds}`);
    write(`pi.debug: ${input.debug}`);
    write(`chat.agent.enabled: ${setting(input.chatAgentEnabled)}`);
    write(`chat.edits2.enabled: ${setting(input.chatEdits2Enabled)}`);
    write(`inlineChat.enableV2: ${setting(input.inlineChatEnableV2)}`);
    write(`probedPiVersion: ${input.probedPiVersion ?? 'not probed'}`);
    write('');
    write('Registered metadata (values this extension returned, not a workbench read-back)');
    if (input.registrationError) {
        write(`registrationError: ${redactSecrets(input.registrationError)}`);
    } else {
        write('registrationError: none');
    }
    write(`registeredCount: ${input.registeredModels.length}`);
    if (input.registeredModels.length === 0) {
        write('registeredModels: none');
    }
    for (const model of input.registeredModels) {
        write(`- id: ${model.id}`);
        write(`  name: ${model.name}`);
        write(`  family: ${model.family}`);
        write(`  version: ${model.version}`);
        write(`  maxInputTokens: ${model.maxInputTokens}`);
        write(`  maxOutputTokens: ${model.maxOutputTokens}`);
        write(`  capabilities.toolCalling: ${model.toolCalling}`);
        write(`  capabilities.imageInput: ${model.imageInput}`);
        write(`  isUserSelectable: ${flag(model.isUserSelectable)}`);
        write(`  targetChatSessionType: ${model.targetChatSessionType ?? 'unset'}`);
        write(`  isBYOK: ${flag(model.isBYOK)}`);
        write(`  category: ${model.category ?? 'unset'}`);
    }
    write('');
    write('vscode.lm.selectChatModels (stable fields only)');
    write(`selectChatModels({ vendor: "pi" }) error: ${input.selectVendorError ? redactSecrets(input.selectVendorError) : 'none'}`);
    write(`selectChatModels({ vendor: "pi" }) count: ${input.selectVendorModels.length}`);
    if (input.selectVendorModels.length === 0) {
        write('selectVendorModels: none');
    }
    for (const model of input.selectVendorModels) {
        write(`- id: ${model.id}`);
        write(`  name: ${model.name}`);
        write(`  vendor: ${model.vendor}`);
        write(`  family: ${model.family}`);
        write(`  version: ${model.version}`);
        write(`  maxInputTokens: ${model.maxInputTokens}`);
        write(`  capabilities.toolCalling: ${flag(model.toolCalling)}`);
        write(`  capabilities.imageInput: ${flag(model.imageInput)}`);
    }
    write(`selectChatModels({}) error: ${input.selectAllError ? redactSecrets(input.selectAllError) : 'none'}`);
    write(`piPresentInUnfilteredSelect: ${input.piPresentInUnfilteredSelect}`);
    if (input.selectAllVendorCounts.length === 0) {
        write('selectAllVendorCounts: none');
    }
    for (const entry of input.selectAllVendorCounts) {
        write(`vendor ${entry.vendor}: ${entry.count}`);
    }
    write('');
    write('Public API limits');
    write('- This extension compiles against @types/vscode 1.109. LanguageModelChat there declares id, name, vendor, family, version, and maxInputTokens. It does not declare capabilities, isUserSelectable, targetChatSessionType, isBYOK, category, detail, or tooltip.');
    write('- capabilities.toolCalling and capabilities.imageInput below are read only when the running host put a capabilities object on the model. Missing properties are "unset".');
    write('- The registered-metadata section is what this extension passed in. VS Code does not offer a read-back of the stored metadata.');
    write('- Profile storage key chatModelVisibility (hidden models) has no extension API.');
    write('- The open chat\'s session resource, mode, and location have no extension API. The session-target control is not that value once a session exists.');
    write('- No command in this extension can read whether the model picker built a provider tab.');
    write('');
    write('Source notes for VS Code 1.144.1 commit 261c84cb (files read; the picker UI was not executed)');
    write('- filterModelsForSession keeps a model when the session type is unset or local, isUserSelectable is not false, targetChatSessionType is unset, the mode is not Agent, and the surface is not editor-inline.');
    write('- isModelHiddenInPicker then removes identifiers stored in chatModelVisibility.');
    write('- Models that remain are grouped by vendor. Vendor "pi" is not the built-in Copilot vendor, so its rows are a separate tab labeled with displayName "Pi Coding Agent", not a row inside the GitHub Copilot tab.');
    write('- mainThreadLanguageModels sets isBYOK true when the provider omits isBYOK and the extension is not the built-in Copilot extension. filterModelsForSession does not read isBYOK. This extension omits isBYOK.');
    write('- requiresCustomModelsForSessionType("local") is false because local is not a contributed session type.');
    return lines.join('\n');
}

function listOrNone(values: readonly string[]): string {
    return values.length === 0 ? 'none' : values.join(', ');
}

function setting(value: boolean | undefined): string {
    return value === undefined ? 'unset' : String(value);
}

function flag(value: boolean | undefined): string {
    return value === undefined ? 'unset' : String(value);
}
