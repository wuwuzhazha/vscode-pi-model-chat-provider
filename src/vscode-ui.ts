import * as vscode from 'vscode';
import { getOutputChannel } from './debug.js';
import {
    mapConfirmChoice,
    mapValueChoice,
    PI_DIALOG_AUTHORITY,
    stringOptions,
    type DialogResult,
    type ExtensionUiRequest,
    type PiUi,
} from './ui-protocol.js';

/**
 * Native VS Code prompts for Pi's extension UI protocol.
 * Dismissing a dialog returns cancelled, which is not the same as Deny.
 */
export function createVsCodeUi(): PiUi {
    const statuses = new Map<string, string>();
    let statusItem: vscode.StatusBarItem | undefined;

    const refreshStatus = () => {
        if (!statusItem) {
            statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
            statusItem.name = 'Pi extension status';
        }
        if (statuses.size === 0) {
            statusItem.hide();
            return;
        }
        statusItem.text = `$(pi-logo) ${Array.from(statuses.values()).join(' · ')}`;
        statusItem.tooltip = Array.from(statuses.entries()).map(([key, value]) => `${key}: ${value}`).join('\n');
        statusItem.show();
    };

    return {
        async confirm(request: ExtensionUiRequest): Promise<DialogResult> {
            const detail = [request.message, PI_DIALOG_AUTHORITY].filter((line) => !!line).join('\n\n');
            const choice = await vscode.window.showWarningMessage(
                request.title || 'Pi is asking for confirmation',
                { modal: true, detail },
                'Allow',
                'Deny'
            );
            return mapConfirmChoice(choice);
        },

        async select(request: ExtensionUiRequest): Promise<DialogResult> {
            const options = stringOptions(request.options);
            if (!options) {
                void vscode.window.showErrorMessage(
                    'Pi asked for a selection but did not send a list of choices. The request was cancelled.'
                );
                return { kind: 'cancel' };
            }
            return pickWithTimeout(request.timeout, (token, timedOut) => vscode.window.showQuickPick(options, {
                title: request.title || 'Pi selection',
                placeHolder: request.message,
                ignoreFocusOut: false,
            }, token).then((value) => mapValueChoice(value, timedOut())));
        },

        async input(request: ExtensionUiRequest): Promise<DialogResult> {
            return pickWithTimeout(request.timeout, (token, timedOut) => vscode.window.showInputBox({
                title: request.title || 'Pi input',
                prompt: `${request.message ?? 'Pi is asking for text.'}\n\n${PI_DIALOG_AUTHORITY}`,
                placeHolder: request.placeholder,
                ignoreFocusOut: false,
            }, token).then((value) => mapValueChoice(value, timedOut())));
        },

        async editor(request: ExtensionUiRequest): Promise<DialogResult> {
            const document = await vscode.workspace.openTextDocument({
                content: request.prefill ?? '',
                language: 'markdown',
            });
            await vscode.window.showTextDocument(document, { preview: false });
            let closed = false;
            const subscription = vscode.workspace.onDidCloseTextDocument((closedDocument) => {
                if (closedDocument === document) {
                    closed = true;
                }
            });
            try {
                const choice = await vscode.window.showInformationMessage(
                    request.title || 'Pi needs a multi-line answer',
                    {
                        modal: false,
                        detail: 'Edit the untitled document, then choose Submit. Dismissing this notification or closing the document cancels the Pi request. The document is not written to the workspace unless you save it.\n\n' + PI_DIALOG_AUTHORITY,
                    },
                    'Submit',
                    'Cancel'
                );
                if (choice !== 'Submit' || closed || document.isClosed) {
                    return { kind: 'cancel' };
                }
                return { kind: 'value', value: document.getText() };
            } finally {
                subscription.dispose();
            }
        },

        notify(request: ExtensionUiRequest): void {
            const message = request.message || request.title || 'Pi notification';
            if (request.notifyType === 'error') {
                void vscode.window.showErrorMessage(message);
            } else if (request.notifyType === 'warning') {
                void vscode.window.showWarningMessage(message);
            } else {
                void vscode.window.showInformationMessage(message);
            }
        },

        setStatus(request: ExtensionUiRequest): void {
            const key = request.statusKey || 'pi';
            if (request.statusText) {
                statuses.set(key, request.statusText);
            } else {
                statuses.delete(key);
            }
            refreshStatus();
        },

        setWidget(request: ExtensionUiRequest): void {
            const lines = Array.isArray(request.widgetLines)
                ? request.widgetLines.filter((line): line is string => typeof line === 'string')
                : [];
            const channel = getOutputChannel();
            channel.appendLine(`[Pi widget ${request.widgetKey ?? ''} ${request.widgetPlacement ?? ''}]`.trim());
            if (lines.length === 0) {
                channel.appendLine('(widget cleared)');
            } else {
                for (const line of lines) {
                    channel.appendLine(line);
                }
            }
        },

        setTitle(request: ExtensionUiRequest): void {
            getOutputChannel().appendLine(
                `Pi requested a terminal title (${request.title ?? ''}). VS Code's window title was not changed.`
            );
        },

        setEditorText(request: ExtensionUiRequest): void {
            const text = request.text ?? '';
            getOutputChannel().appendLine('Pi asked to prefill its editor. The chat input was not modified.');
            getOutputChannel().appendLine(text);
            const preview = text.length > 180 ? `${text.slice(0, 180)}…` : text;
            void vscode.window.showInformationMessage(
                `Pi tried to prefill an editor. This chat box was not changed. ${preview}`
            );
        },
    };
}

async function pickWithTimeout(
    timeout: number | undefined,
    show: (token: vscode.CancellationToken, timedOut: () => boolean) => Thenable<DialogResult>
): Promise<DialogResult> {
    const source = new vscode.CancellationTokenSource();
    let timedOut = false;
    const timer = typeof timeout === 'number' && timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            source.cancel();
        }, timeout)
        : undefined;
    try {
        return await show(source.token, () => timedOut);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
        source.dispose();
    }
}
