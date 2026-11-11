import { sha256 } from './hash.js';

/** Neutral chat message used by session and prompt code. VS Code types stay at the edge. */
export interface InboundPart {
    kind: 'text' | 'image' | 'data' | 'tool-call' | 'tool-result' | 'thinking' | 'unknown';
    text?: string;
    mimeType?: string;
    data?: Uint8Array;
    toolName?: string;
    toolCallId?: string;
    input?: unknown;
    resultParts?: InboundPart[];
    /** Constructor or type name, used when the part cannot be represented. */
    label?: string;
}

export interface InboundMessage {
    role: 'user' | 'assistant';
    name?: string;
    parts: InboundPart[];
}

export interface PromptImage {
    type: 'image';
    data: string;
    mimeType: string;
}

export interface PreparedPrompt {
    text: string;
    images: PromptImage[];
    /** Shown in chat and also included in the text sent to Pi. */
    limitations: string[];
    /** False when there is nothing new to send (duplicate snapshot). */
    send: boolean;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const RESTORE_PREAMBLE = [
    'The VS Code Pi provider restored this chat into a new Pi process',
    '(new chat, edited history, reload, cancelled turn, crashed process, or a different model or folder).',
    'Respond only to the final user message. Earlier turns are context.',
    'Pi tools are not VS Code tools. Nothing in this transcript is a VS Code tool approval.',
].join(' ');

export function canonicalTranscript(
    messages: readonly InboundMessage[],
    modelId: string,
    cwd: string
): string {
    const body = messages.map((message) => {
        const encoded = JSON.stringify({
            role: message.role,
            name: message.name ?? '',
            parts: message.parts.map(canonicalPart),
        });
        return `${Buffer.byteLength(encoded)}:${encoded}`;
    }).join('');
    return `${JSON.stringify({ cwd, modelId })}\n${body}`;
}

export function preparePrompt(
    messages: readonly InboundMessage[],
    mode: 'replay' | 'continuation'
): PreparedPrompt {
    const limitations: string[] = [];
    const images: PromptImage[] = [];
    const blocks: string[] = [];

    if (mode === 'replay') {
        blocks.push(RESTORE_PREAMBLE);
        blocks.push('<transcript>');
    }

    const lastUserIndex = findLastUserIndex(messages);
    messages.forEach((message, index) => {
        const attachImages = mode === 'continuation'
            ? message.role === 'user'
            : index === lastUserIndex;
        blocks.push(renderMessage(message, {
            attachImages,
            images,
            limitations,
            skipAssistant: mode === 'continuation' && message.role === 'assistant',
        }));
    });

    if (mode === 'replay') {
        blocks.push('</transcript>');
    }

    const visible = blocks.filter((block) => block.length > 0);
    if (visible.length === 0 && images.length === 0 && limitations.length === 0) {
        limitations.push('This request had no text, image, or tool content the provider could forward to Pi.');
    }

    if (limitations.length > 0) {
        visible.push(limitations.map((line) => `[provider limitation] ${line}`).join('\n'));
    }

    let text = visible.join('\n\n').trim();
    if (!text && images.length > 0) {
        text = 'The user attached an image.';
    }

    return {
        text,
        images,
        limitations,
        send: text.length > 0 || images.length > 0,
    };
}

function findLastUserIndex(messages: readonly InboundMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            return i;
        }
    }
    return -1;
}

function renderMessage(
    message: InboundMessage,
    ctx: {
        attachImages: boolean;
        images: PromptImage[];
        limitations: string[];
        skipAssistant: boolean;
    }
): string {
    if (ctx.skipAssistant) {
        return '';
    }
    const lines: string[] = [];
    const who = message.name ? `${message.role} (${message.name})` : message.role;
    lines.push(`[${who}]`);
    for (const part of message.parts) {
        lines.push(renderPart(part, ctx));
    }
    return lines.filter((line) => line.length > 0).join('\n');
}

function renderPart(
    part: InboundPart,
    ctx: { attachImages: boolean; images: PromptImage[]; limitations: string[] }
): string {
    if (part.kind === 'text') {
        return part.text ?? '';
    }
    if (part.kind === 'thinking') {
        const body = part.text ?? '';
        if (!body) {
            ctx.limitations.push('A thinking part had no text and was not forwarded.');
            return '[thinking part had no text]';
        }
        return `[thinking]\n${body}`;
    }
    if (part.kind === 'image') {
        return renderImage(part, ctx);
    }
    if (part.kind === 'data') {
        const mime = part.mimeType ?? 'application/octet-stream';
        const bytes = part.data?.byteLength ?? 0;
        ctx.limitations.push(
            `Attachment ${mime} (${bytes} bytes) was not sent to Pi. This provider forwards text and image/* bytes only.`
        );
        return `[unsupported attachment ${mime}, ${bytes} bytes, not sent]`;
    }
    if (part.kind === 'tool-call') {
        ctx.limitations.push(
            `VS Code tool call "${part.toolName ?? 'unknown'}" was included as text. It was not sent to Pi as a Pi tool call and was not invoked again.`
        );
        return `[VS Code tool call ${part.toolName ?? 'unknown'} id=${part.toolCallId ?? ''} input=${safeJson(part.input)}]`;
    }
    if (part.kind === 'tool-result') {
        const inner = (part.resultParts ?? []).map((child) => renderPart(child, {
            ...ctx,
            attachImages: false,
        }));
        ctx.limitations.push(
            `VS Code tool result ${part.toolCallId ?? ''} is forwarded as text for Pi to read. This provider does not run that tool and does not ask Pi to run it.`
        );
        return `[VS Code tool result ${part.toolCallId ?? ''} — already executed by VS Code; do not run it again]\n${inner.join('\n')}`.trim();
    }
    const label = part.label ?? part.mimeType ?? 'unknown';
    const bytes = part.data?.byteLength;
    ctx.limitations.push(
        `Unsupported message part (${label}) was not sent to Pi${bytes !== undefined ? ` (${bytes} bytes)` : ''}.`
    );
    return `[unsupported part ${label}${part.text ? `: ${part.text}` : ''}]`;
}

function renderImage(
    part: InboundPart,
    ctx: { attachImages: boolean; images: PromptImage[]; limitations: string[] }
): string {
    const mime = part.mimeType ?? 'image/unknown';
    const bytes = part.data?.byteLength ?? 0;
    if (!part.data || bytes === 0) {
        ctx.limitations.push(`Image ${mime} had no bytes and was not sent to Pi.`);
        return `[image ${mime} had no bytes and was not sent]`;
    }
    if (bytes > MAX_IMAGE_BYTES) {
        ctx.limitations.push(
            `Image ${mime} is ${bytes} bytes, over the ${MAX_IMAGE_BYTES} byte limit, and was not sent to Pi.`
        );
        return `[image ${mime}, ${bytes} bytes, not sent because it exceeds the provider limit]`;
    }
    if (!ctx.attachImages) {
        ctx.limitations.push(
            `Image ${mime} (${bytes} bytes) from earlier in the transcript was not attached. Pi prompt images are sent only with the current user message.`
        );
        return `[earlier image ${mime}, ${bytes} bytes, not re-attached]`;
    }
    ctx.images.push({
        type: 'image',
        mimeType: mime,
        data: Buffer.from(part.data).toString('base64'),
    });
    return `[image attached ${mime}, ${bytes} bytes]`;
}

function canonicalPart(part: InboundPart): unknown {
    if (part.kind === 'image' || part.kind === 'data') {
        return {
            kind: part.kind,
            mimeType: part.mimeType ?? '',
            sha256: sha256(part.data ?? new Uint8Array()),
            bytes: part.data?.byteLength ?? 0,
        };
    }
    if (part.kind === 'tool-result') {
        return {
            kind: 'tool-result',
            toolCallId: part.toolCallId ?? '',
            parts: (part.resultParts ?? []).map(canonicalPart),
        };
    }
    return {
        kind: part.kind,
        text: part.text ?? '',
        mimeType: part.mimeType ?? '',
        toolName: part.toolName ?? '',
        toolCallId: part.toolCallId ?? '',
        input: part.input ?? null,
        label: part.label ?? '',
    };
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value ?? null);
    } catch {
        return '"[unserializable]"';
    }
}
