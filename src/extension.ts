/**
 * Pi Language Model Provider
 * Fork of tintinweb/vscode-pi-model-chat-provider (MIT).
 * Native VS Code language model provider backed by the Pi CLI. Not a webview
 * and not a chat participant.
 */

import * as vscode from 'vscode';
import { getOutputChannel } from './debug.js';
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
        'Host tool calling is disabled. Pi tools run inside Pi and are shown as text.'
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

function numberSetting(value: number | undefined, fallback: number, min: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(min, Math.floor(value));
}
