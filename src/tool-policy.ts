/**
 * Two tool systems:
 * - Host tools are the ones VS Code put on the request. This provider emits
 *   `LanguageModelToolCallPart` only for a `host_tool_request` whose name was
 *   offered and that Pi did not already start. VS Code then runs that tool.
 * - Pi tools (bash, read, edit, and anything else Pi starts) run inside Pi.
 *   They are text in the chat. They are never also sent to VS Code.
 *
 * A VS Code tool approval does not approve Pi tools. Allow on a Pi dialog
 * does not approve a VS Code tool.
 */
export const HOST_TOOL_BOUNDARY =
    'Host tools run in VS Code only after this provider emits a tool-call part for an offered tool Pi did not already start. ' +
    'Pi tools run inside Pi and stay text. Neither approval covers the other system.';

export const MODEL_DETAIL = 'Host tools are forwarded only when Pi asks and has not already run them. Pi tools stay inside Pi.';

export const MODEL_TOOLTIP =
    'Pi Coding Agent through the language model provider API. ' +
    HOST_TOOL_BOUNDARY;

/** VS Code `LanguageModelChatToolMode.Auto`. The model may answer with text. */
export const TOOL_MODE_AUTO = 1;
/** VS Code `LanguageModelChatToolMode.Required`. The response must include a host tool call. */
export const TOOL_MODE_REQUIRED = 2;

export interface HostToolOffer {
    readonly name: string;
}

export interface HostToolRequest {
    readonly callId: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
}

export interface HostToolTurn {
    readonly calls: readonly HostToolRequest[];
    readonly notices: readonly string[];
    readonly error?: string;
}

/**
 * Decide which host tool calls to emit after Pi's stream ends.
 * Does not invent a call. Does not forward a tool Pi already started.
 */
export function resolveHostToolTurn(input: {
    readonly toolMode: number | undefined;
    readonly offered: readonly HostToolOffer[];
    readonly priorCallIds: ReadonlySet<string>;
    readonly requested: readonly HostToolRequest[];
    readonly executedByPi: readonly string[];
}): HostToolTurn {
    const offered = new Set(input.offered.map((tool) => tool.name).filter((name) => name.length > 0));
    const executed = new Set(input.executedByPi);
    const seen = new Set(input.priorCallIds);
    const calls: HostToolRequest[] = [];
    const notices: string[] = [];

    input.requested.forEach((request, index) => {
        const name = request.name.trim();
        if (!name) {
            notices.push('Ignored a host tool request with no name.');
            return;
        }
        if (!offered.has(name)) {
            notices.push(
                `Pi requested "${name}", which VS Code did not offer. It was not called.`
            );
            return;
        }
        if (executed.has(name)) {
            notices.push(
                `Pi already started "${name}" inside the Pi process. That call was not sent to VS Code, so it is not run a second time.`
            );
            return;
        }
        const callId = request.callId.trim() || fallbackCallId(name, request.input, index);
        if (seen.has(callId)) {
            notices.push(
                `Host tool call "${callId}" was already sent. It was not sent again.`
            );
            return;
        }
        seen.add(callId);
        calls.push({ callId, name, input: request.input });
    });

    if (input.toolMode === TOOL_MODE_REQUIRED && calls.length === 0) {
        return {
            calls: [],
            notices,
            error:
                'toolMode Required needs a host tool call for an offered tool. ' +
                'Pi did not request one that it had not already started. ' +
                'This provider does not invent a call and does not run host tools inside Pi. ' +
                HOST_TOOL_BOUNDARY,
        };
    }
    if (offered.size > 0 && calls.length === 0 && input.toolMode !== TOOL_MODE_REQUIRED) {
        notices.push(
            'VS Code offered host tools. Pi did not request one that was still unstarted, so none were called. ' +
            'Pi tools, if any, ran only inside Pi.'
        );
    }
    return { calls, notices };
}

function fallbackCallId(name: string, input: Record<string, unknown>, index: number): string {
    const raw = JSON.stringify(input);
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
        hash = (Math.imul(hash, 31) + raw.charCodeAt(i)) >>> 0;
    }
    return `host:${name}:${index}:${hash.toString(16)}`;
}

/** Capabilities reported to VS Code. toolCalling true is what 1.144 Agent-kind modes require. */
export function modelCapabilities(): { readonly toolCalling: true; readonly imageInput: true } {
    return { toolCalling: true, imageInput: true };
}

/**
 * Chat-picker eligibility transcribed from VS Code 1.144.1 (commit 261c84cb).
 * `mode: 'ask'` is `ChatModeKind.Ask`. The mode button labeled Ask on that
 * build is normally the Copilot custom agent, whose omitted `kind` becomes
 * `ChatModeKind.Agent` (`chatModes.ts`). That path is `mode: 'agent'` here.
 * With `toolCalling` true that labeled Ask path can list the model.
 *
 * `filterModelsForSession` in
 * src/vs/workbench/contrib/chat/browser/widget/input/chatInputModelUtils.ts
 * and `suitableForAgentMode` in
 * src/vs/workbench/contrib/chat/common/languageModels.ts.
 * The extension host sets `agentMode` from `toolCalling` in
 * src/vs/workbench/api/common/extHostLanguageModels.ts.
 */
export type ChatPickerMode = 'ask' | 'edit' | 'agent';

export function visibleInChatModelPicker(options: {
    readonly isUserSelectable: boolean | undefined;
    readonly toolCalling: boolean;
    readonly mode: ChatPickerMode;
    readonly edits2Enabled: boolean;
    readonly inlineChatV2: boolean;
    /** Undefined or `local` uses the general pool. Any other type with its own models does not. */
    readonly sessionType?: string;
    readonly sessionHasOwnModelPool: boolean;
    readonly targetChatSessionType?: string;
    /**
     * `isModelHiddenInPicker` after the session filter. Profile storage
     * `chatModelVisibility`. Omitted means not hidden.
     */
    readonly hidden?: boolean;
}): boolean {
    if (options.hidden) {
        return false;
    }
    if (options.isUserSelectable === false) {
        return false;
    }
    const sessionType = options.sessionType;
    if (sessionType && sessionType !== 'local' && options.sessionHasOwnModelPool) {
        return options.targetChatSessionType === sessionType;
    }
    if (options.targetChatSessionType) {
        return false;
    }
    const agentFiltered = options.mode === 'agent' || (options.mode === 'edit' && options.edits2Enabled);
    if (agentFiltered && !options.toolCalling) {
        return false;
    }
    if (options.inlineChatV2 && !options.toolCalling) {
        return false;
    }
    return true;
}
