import { HostToolsError } from './errors.js';

/**
 * Copy used in the model picker, chat, and README. Pi's tools are not
 * VS Code language-model tools.
 */
export const HOST_TOOL_NOTICE =
    'VS Code offered host tools to this model. This provider does not call them and does not emit VS Code tool cards. ' +
    'Pi may still run its own bash, read, and edit tools inside the Pi process. ' +
    'A VS Code tool approval does not approve Pi tools, and Allow on a Pi dialog does not approve VS Code tools.';

export const MODEL_DETAIL = 'Pi runs its own tools inside Pi. Not a VS Code agent-tool model.';

export const MODEL_TOOLTIP =
    'Pi Coding Agent through the language model provider API. ' +
    'Host tool calling is off. Tool activity is text, not a VS Code tool card. ' +
    HOST_TOOL_NOTICE;

export interface HostToolDecision {
    notice?: string;
}

/**
 * `toolCalling` is advertised as false. If a host asks anyway:
 * - Required cannot be honored, so the request fails visibly.
 * - Auto is answered with text and a single notice, never with tool-call parts.
 */
export function decideHostTools(toolMode: number | undefined, toolCount: number): HostToolDecision {
    if (toolMode === 2) {
        throw new HostToolsError(
            'This Pi provider cannot honor toolMode Required. ' +
            'It does not implement VS Code host tool calls. ' +
            HOST_TOOL_NOTICE
        );
    }
    if (toolCount > 0) {
        return { notice: HOST_TOOL_NOTICE };
    }
    return {};
}

/** Capabilities reported to VS Code. toolCalling false means this is not an agent-mode model. */
export function modelCapabilities(): { readonly toolCalling: false; readonly imageInput: true } {
    return { toolCalling: false, imageInput: true };
}
