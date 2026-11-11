/**
 * Debug logging utility.
 * Writes to the shared "Pi Agent" output channel when pi.debug is enabled.
 */

import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('Pi Agent');
    }
    return channel;
}

export function debug(...args: unknown[]): void {
    const isDebugEnabled = vscode.workspace.getConfiguration('pi').get<boolean>('debug', false);
    if (!isDebugEnabled) {
        return;
    }
    const message = args.map((value) => {
        if (typeof value === 'string') {
            return value;
        }
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }).join(' ');
    getOutputChannel().appendLine(`[debug] ${message}`);
}
