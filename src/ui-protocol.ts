/**
 * Pi extension UI request/response mapping.
 * Closing a dialog is `cancelled: true`, which is distinct from confirm: false.
 * A timeout result sends nothing: Pi auto-resolves dialog timeouts itself.
 */

export interface ExtensionUiRequest {
    id: string;
    method: string;
    title?: string;
    message?: string;
    options?: unknown;
    placeholder?: string;
    prefill?: string;
    notifyType?: string;
    statusKey?: string;
    statusText?: string | null;
    widgetKey?: string;
    widgetLines?: unknown;
    widgetPlacement?: string;
    text?: string;
    timeout?: number;
}

export type DialogResult =
    | { kind: 'value'; value: string }
    | { kind: 'confirm'; confirmed: boolean }
    | { kind: 'cancel' }
    | { kind: 'timeout' };

export interface PiUi {
    confirm(request: ExtensionUiRequest): Promise<DialogResult>;
    select(request: ExtensionUiRequest): Promise<DialogResult>;
    input(request: ExtensionUiRequest): Promise<DialogResult>;
    editor(request: ExtensionUiRequest): Promise<DialogResult>;
    notify(request: ExtensionUiRequest): void;
    setStatus(request: ExtensionUiRequest): void;
    setWidget(request: ExtensionUiRequest): void;
    setTitle(request: ExtensionUiRequest): void;
    setEditorText(request: ExtensionUiRequest): void;
}

const DIALOG_METHODS = new Set(['confirm', 'select', 'input', 'editor']);

export function isDialogMethod(method: string): boolean {
    return DIALOG_METHODS.has(method);
}

export function dialogToResponse(
    id: string,
    result: DialogResult
): Record<string, unknown> | undefined {
    if (result.kind === 'timeout') {
        return undefined;
    }
    if (result.kind === 'cancel') {
        return { type: 'extension_ui_response', id, cancelled: true };
    }
    if (result.kind === 'confirm') {
        return { type: 'extension_ui_response', id, confirmed: result.confirmed };
    }
    return { type: 'extension_ui_response', id, value: result.value };
}

export function mapConfirmChoice(selection: string | undefined): DialogResult {
    if (selection === 'Allow') {
        return { kind: 'confirm', confirmed: true };
    }
    if (selection === 'Deny') {
        return { kind: 'confirm', confirmed: false };
    }
    return { kind: 'cancel' };
}

export function mapValueChoice(
    value: string | undefined,
    closedByTimeout: boolean
): DialogResult {
    if (value === undefined && closedByTimeout) {
        return { kind: 'timeout' };
    }
    if (value === undefined) {
        return { kind: 'cancel' };
    }
    return { kind: 'value', value };
}

export function stringOptions(options: unknown): string[] | undefined {
    if (!Array.isArray(options)) {
        return undefined;
    }
    const values = options.filter((option): option is string => typeof option === 'string');
    if (values.length !== options.length || values.length === 0) {
        return undefined;
    }
    return values;
}

export async function dispatchExtensionUi(
    request: ExtensionUiRequest,
    ui: PiUi
): Promise<Record<string, unknown> | undefined> {
    switch (request.method) {
        case 'confirm':
            return dialogToResponse(request.id, await ui.confirm(request));
        case 'select':
            return dialogToResponse(request.id, await ui.select(request));
        case 'input':
            return dialogToResponse(request.id, await ui.input(request));
        case 'editor':
            return dialogToResponse(request.id, await ui.editor(request));
        case 'notify':
            ui.notify(request);
            return undefined;
        case 'setStatus':
            ui.setStatus(request);
            return undefined;
        case 'setWidget':
            ui.setWidget(request);
            return undefined;
        case 'setTitle':
            ui.setTitle(request);
            return undefined;
        case 'set_editor_text':
            ui.setEditorText(request);
            return undefined;
        default:
            return undefined;
    }
}

export const PI_DIALOG_AUTHORITY =
    'This dialog is from Pi, not from VS Code tool approval. ' +
    'Allow and Deny apply only to this Pi prompt. Closing the dialog cancels it. ' +
    'Pi can still run tools under its own settings when it does not ask.';
