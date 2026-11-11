import type { PiEvent } from './protocol/events.js';
import type { HostToolRequest } from './tool-policy.js';

export interface StreamState {
    streamedText: boolean;
    reportedToolActivity: boolean;
    agentError?: string;
    limitations: string[];
    /** Tools Pi started. These must not also be sent to VS Code. */
    piExecutedTools: string[];
    /** Host tool requests Pi emitted without starting the tool. */
    hostToolRequests: HostToolRequest[];
}

/**
 * Turn Pi events into chat text. Host tool-call parts are decided later from
 * `hostToolRequests` and are not produced here.
 */
export function applyAgentEvent(event: PiEvent, state: StreamState): string[] {
    const chunks: string[] = [];

    if (event.type === 'message_update') {
        const update = event.assistantMessageEvent;
        if (update?.type === 'text_delta' && update.delta) {
            state.streamedText = true;
            chunks.push(update.delta);
        } else if (update?.type === 'thinking_delta' && update.delta) {
            chunks.push(fenceBlock(`[pi reasoning]\n${update.delta}`));
        } else if (update?.type && update.type !== 'text_delta' && update.type !== 'thinking_delta') {
            const note = `Pi sent message_update "${update.type}", which this provider does not render as a native card.`;
            if (!state.limitations.includes(note)) {
                state.limitations.push(note);
                chunks.push(`[provider limitation] ${note}`);
            }
        }
    }

    if (event.type === 'message_end') {
        const error = extractAgentError(event.message);
        if (error) {
            state.agentError = error;
        }
    }

    if (event.type === 'host_tool_request') {
        state.hostToolRequests.push(readHostToolRequest(event));
        return chunks;
    }

    if (event.type === 'tool_execution_start') {
        state.reportedToolActivity = true;
        if (event.toolName) {
            state.piExecutedTools.push(event.toolName);
        }
        const args = event.args && typeof event.args === 'object' && Object.keys(event.args).length > 0
            ? ` ${JSON.stringify(event.args)}`
            : '';
        chunks.push(fenceBlock(`[pi tool ${event.toolName ?? 'unknown'}]${args}\nPi is running this tool inside the Pi process. It is not a VS Code tool call and was not approved by VS Code.`));
    }

    if (event.type === 'tool_execution_end') {
        const content = event.result?.content ?? [];
        const texts: string[] = [];
        for (const block of content) {
            if (block?.type === 'text' && block.text) {
                texts.push(block.text);
                continue;
            }
            const kind = block?.type ?? 'unknown';
            const mime = block?.mimeType ? ` ${block.mimeType}` : '';
            const note = `Pi tool result included ${kind}${mime} content, shown here as a note instead of a native VS Code card.`;
            state.limitations.push(note);
            texts.push(`[provider limitation] ${note}`);
        }
        if (texts.length > 0 || event.isError) {
            state.reportedToolActivity = true;
            const header = event.isError ? '[pi tool error]' : '[pi tool result]';
            chunks.push(fenceBlock(`${header}\n${texts.join('\n')}`));
        }
    }

    return chunks;
}

export function fenceBlock(text: string): string {
    const longestRun = (text.match(/`+/g) ?? [])
        .reduce((max, run) => Math.max(max, run.length), 0);
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    return `\n${fence}\n${text}\n${fence}\n`;
}

export function extractAgentError(message: unknown): string | undefined {
    if (!message || typeof message !== 'object') {
        return undefined;
    }
    const record = message as { role?: string; stopReason?: string; errorMessage?: string };
    if (record.role === 'assistant' && (record.stopReason === 'error' || record.stopReason === 'aborted')) {
        return record.errorMessage || `stopReason: ${record.stopReason}`;
    }
    return undefined;
}

export function createStreamState(): StreamState {
    return {
        streamedText: false,
        reportedToolActivity: false,
        limitations: [],
        piExecutedTools: [],
        hostToolRequests: [],
    };
}

function readHostToolRequest(event: PiEvent): HostToolRequest {
    const name = typeof event.toolName === 'string' ? event.toolName : '';
    const callId = typeof event.callId === 'string' ? event.callId : '';
    const raw = isPlainObject(event.input) ? event.input : isPlainObject(event.args) ? event.args : {};
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
        input[key] = value;
    }
    return { callId, name, input };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
