/**
 * Pi Language Model Provider
 * Fork of tintinweb/vscode-pi-model-chat-provider (MIT).
 * Native VS Code language model provider backed by the Pi CLI. Not a webview
 * and not a chat participant.
 */

import * as vscode from 'vscode';
import { getOutputChannel } from './debug.js';
import {
    describeBinaryPath,
    formatPickerDiagnostics,
    redactSecrets,
    type SelectChatModelObservation,
    type VendorCount,
} from './picker-diagnostics.js';
import { PiChatProvider } from './provider.js';
import { SessionPool, type PoolEnvironment } from './session-pool.js';
import type { PiConfig } from './types.js';
import { createVsCodeUi } from './vscode-ui.js';

let pool: SessionPool | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const channel = getOutputChannel();
    channel.appendLine(
        'Pi language model provider — fork of tintinweb/vscode-pi-model-chat-provider (MIT), ' +
        'repository wuwuzhazha/vscode-pi-model-chat-provider. ' +
        'Host tool calls are forwarded only when Pi requests an offered tool it has not already started. Pi tools stay inside Pi.'
    );
    context.subscriptions.push(channel);

    const environment = createEnvironment();
    const ui = createVsCodeUi();
    const logger = {
        info: (message: string) => getOutputChannel().appendLine(message),
        debug: (message: string) => {
            if (vscode.workspace.getConfiguration('pi').get<boolean>('debug', false)) {
                getOutputChannel().appendLine(`[debug] ${message}`);
            }
        },
    };
    let provider: PiChatProvider;
    const replacePool = () => {
        const previous = pool;
        pool = new SessionPool(loadConfiguration(), environment, ui, logger);
        provider.setPool(pool);
        void previous?.dispose();
    };

    pool = new SessionPool(loadConfiguration(), environment, ui, logger);
    provider = new PiChatProvider(pool);

    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider('pi', provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('pi.showModelPickerDiagnostics', async () => {
            const report = await collectPickerDiagnostics(context, provider);
            getOutputChannel().appendLine(report);
            try {
                const document = await vscode.workspace.openTextDocument({
                    content: report,
                    language: 'plaintext',
                });
                await vscode.window.showTextDocument(document, { preview: false });
            } catch (error) {
                const message = redactSecrets(error instanceof Error ? error.message : String(error));
                getOutputChannel().appendLine(`Could not open the diagnostics editor: ${message}`);
                void vscode.window.showWarningMessage(
                    'Pi model picker diagnostics were written to the Pi Agent output channel.'
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration('pi')) {
                return;
            }
            replacePool();
            void vscode.window.showInformationMessage(
                'Pi configuration updated. New requests use the updated settings. In-memory Pi sessions were stopped.'
            );
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            replacePool();
        })
    );

    context.subscriptions.push({
        dispose: () => {
            void pool?.dispose();
        },
    });
}

export async function deactivate(): Promise<void> {
    if (pool) {
        await pool.dispose();
        pool = undefined;
    }
}

function createEnvironment(): PoolEnvironment {
    return {
        isTrusted: () => vscode.workspace.isTrusted,
        workspaceFolders: () => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
    };
}

export function loadConfiguration(): PiConfig {
    const config = vscode.workspace.getConfiguration('pi');
    const idleSeconds = numberSetting(config.get<number>('sessionIdleTimeout'), 600, 0);
    return {
        binaryPath: config.get<string>('binaryPath') || 'pi',
        workingDirectory: config.get<string>('workingDirectory') || '',
        autoRestart: config.get<boolean>('autoRestart') ?? true,
        maxRestartAttempts: numberSetting(config.get<number>('maxRestartAttempts'), 3, 0),
        additionalArgs: config.get<string[]>('additionalArgs') || [],
        commandTimeoutMs: numberSetting(config.get<number>('commandTimeoutMs'), 30_000, 200),
        hungRequestTimeoutMs: numberSetting(config.get<number>('hungRequestTimeoutMs'), 0, 0),
        shutdownGraceMs: numberSetting(config.get<number>('shutdownGraceMs'), 5_000, 200),
        persistSessions: config.get<boolean>('persistSessions') ?? false,
        sessionDirectory: config.get<string>('sessionDirectory') || '',
        maxSessions: numberSetting(config.get<number>('maxSessions'), 20, 1),
        sessionIdleTimeoutMs: idleSeconds === 0 ? 0 : idleSeconds * 1000,
        debug: config.get<boolean>('debug') ?? false,
    };
}

async function collectPickerDiagnostics(
    context: vscode.ExtensionContext,
    provider: PiChatProvider
): Promise<string> {
    const pkg = context.extension.packageJSON as {
        version?: string;
        publisher?: string;
        engines?: { vscode?: string };
        enabledApiProposals?: string[];
        activationEvents?: string[];
        contributes?: {
            languageModelChatProviders?: { vendor?: string; displayName?: string; when?: string }[];
        };
    };
    const contribution = pkg.contributes?.languageModelChatProviders?.[0];
    const config = loadConfiguration();
    const binary = describeBinaryPath(config.binaryPath);
    const chat = vscode.workspace.getConfiguration('chat');
    const inlineChat = vscode.workspace.getConfiguration('inlineChat');

    const vendorSelect = await observeSelect({ vendor: 'pi' });
    const allSelect = await observeSelect({});
    const registration = provider.registrationSnapshot();
    const counts = vendorCounts(allSelect.models);
    const piPresent = allSelect.models.some((model) => model.vendor === 'pi');

    return formatPickerDiagnostics({
        generatedAt: new Date().toISOString(),
        extensionId: context.extension.id,
        extensionVersion: pkg.version ?? 'unknown',
        publisher: pkg.publisher ?? 'unknown',
        enginesVscode: pkg.engines?.vscode ?? 'unknown',
        vscodeVersion: vscode.version,
        enabledApiProposals: pkg.enabledApiProposals ?? [],
        activationEvents: pkg.activationEvents ?? [],
        vendor: contribution?.vendor ?? 'pi',
        vendorDisplayName: contribution?.displayName ?? '',
        vendorWhen: contribution?.when,
        workspaceTrusted: vscode.workspace.isTrusted,
        workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
        binaryPathKind: binary.kind,
        binaryBaseName: binary.baseName,
        additionalArgsCount: config.additionalArgs.length,
        autoRestart: config.autoRestart,
        maxRestartAttempts: config.maxRestartAttempts,
        commandTimeoutMs: config.commandTimeoutMs,
        hungRequestTimeoutMs: config.hungRequestTimeoutMs,
        shutdownGraceMs: config.shutdownGraceMs,
        persistSessions: config.persistSessions,
        sessionDirectorySet: config.sessionDirectory.trim().length > 0,
        workingDirectorySet: config.workingDirectory.trim().length > 0,
        maxSessions: config.maxSessions,
        sessionIdleTimeoutSeconds: Math.round(config.sessionIdleTimeoutMs / 1000),
        debug: config.debug,
        chatAgentEnabled: chat.get<boolean>('agent.enabled'),
        chatEdits2Enabled: chat.get<boolean>('edits2.enabled'),
        inlineChatEnableV2: inlineChat.get<boolean>('enableV2'),
        probedPiVersion: registration.piVersion,
        registrationError: registration.error,
        registeredModels: registration.models,
        selectVendorError: vendorSelect.error,
        selectVendorModels: vendorSelect.models,
        selectAllError: allSelect.error,
        selectAllVendorCounts: counts,
        piPresentInUnfilteredSelect: piPresent,
    });
}

async function observeSelect(
    selector: { vendor?: string }
): Promise<{ models: SelectChatModelObservation[]; error?: string }> {
    try {
        const models = await vscode.lm.selectChatModels(selector);
        return { models: models.map((model) => observeModel(model)) };
    } catch (error) {
        return { models: [], error: redactSecrets(error instanceof Error ? error.message : String(error)) };
    }
}

function observeModel(model: vscode.LanguageModelChat): SelectChatModelObservation {
    const extra = model as vscode.LanguageModelChat & {
        capabilities?: { toolCalling?: boolean; imageInput?: boolean };
    };
    return {
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        family: model.family,
        version: model.version,
        maxInputTokens: model.maxInputTokens,
        toolCalling: extra.capabilities?.toolCalling,
        imageInput: extra.capabilities?.imageInput,
    };
}

function vendorCounts(models: readonly SelectChatModelObservation[]): VendorCount[] {
    const counts = new Map<string, number>();
    for (const model of models) {
        counts.set(model.vendor, (counts.get(model.vendor) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([vendor, count]) => ({ vendor, count }));
}

function numberSetting(value: number | undefined, fallback: number, min: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(min, Math.floor(value));
}
