/**
 * Subset of Pi RPC stdout records this provider understands.
 * Fields are optional because Pi adds event data across versions.
 */
export interface PiEvent {
    type: string;
    id?: string;
    aborted?: boolean;
    assistantMessageEvent?: {
        type?: string;
        delta?: string;
    };
    toolName?: string;
    args?: unknown;
    isError?: boolean;
    result?: {
        content?: Array<{
            type?: string;
            text?: string;
            mimeType?: string;
            data?: string;
        }>;
    };
    message?: unknown;
    [key: string]: unknown;
}

export interface RpcResponseRecord {
    type: 'response';
    id?: string;
    command?: string;
    success?: boolean;
    data?: unknown;
    error?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
