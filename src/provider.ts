import * as vscode from 'vscode';
import { PiCancelledError, PiError } from './errors.js';
import type { InboundMessage, InboundPart } from './messages.js';
import { parseRegisteredModelId } from './model-id.js';
import type { PiModelInfo } from './pi-process.js';
import { applyAgentEvent, createStreamState } from './render.js';
import type { SessionPool } from './session-pool.js';
import { decideHostTools, MODEL_DETAIL, MODEL_TOOLTIP, modelCapabilities } from './tool-policy.js';
import { debug, getOutputChannel } from './debug.js';
import { redactSecrets, type RegisteredModelRecord } from './picker-diagnostics.js';

/**
 * Native language model chat provider. Pi stays behind RPC.
 * This is not a chat participant and not a webview.
 */
export interface RegistrationSnapshot {
    readonly models: readonly RegisteredModelRecord[];
    readonly error?: string;
    readonly piVersion?: string;
}

export class PiChatProvider implements vscode.LanguageModelChatProvider {
    private readonly modelProviders = new Map<string, string>();
    private warned = false;
    private registration: { models: RegisteredModelRecord[]; error?: string } = { models: [] };

    constructor(private pool: SessionPool) {}

    setPool(pool: SessionPool): void {
        this.pool = pool;
    }

    /** Last provideLanguageModelChatInformation result. Metadata is what this extension sent. */
    registrationSnapshot(): RegistrationSnapshot {
        return {
            models: this.registration.models,
            error: this.registration.error,
            piVersion: this.pool.probedPiVersion(),
        };
    }

    async provideLanguageModelChatInformation(
        _options: { silent?: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        try {
            const models = await this.pool.getAvailableModels();
            this.modelProviders.clear();
            const infos = models.map((model) => this.toModelInformation(model));
            this.registration = { models: infos.map((info) => recordFromInfo(info)) };
            const ids = this.registration.models.map((model) => model.id).join(', ');
            getOutputChannel().appendLine(
                `Registered ${this.registration.models.length} Pi model(s)` +
                `${ids ? `: ${ids}` : ''}. ` +
                'toolCalling=false; isUserSelectable=true; targetChatSessionType unset; isBYOK unset.'
            );
            return infos;
        } catch (error) {
            const message = redactSecrets(error instanceof Error ? error.message : String(error));
            this.registration = { models: [], error: message };
            this.modelProviders.clear();
            console.error('Failed to get Pi models:', message);
            getOutputChannel().appendLine(`Pi model registration failed: ${message}`);
            if (!this.warned) {
                this.warned = true;
                void vscode.window.showWarningMessage(message);
            }
            return [];
        }
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const parsed = parseRegisteredModelId(model.id, this.modelProviders);
        const decision = decideHostTools(options.toolMode, options.tools?.length ?? 0);
        if (decision.notice) {
            progress.report(new vscode.LanguageModelTextPart(decision.notice));
        }

        const inbound = messages.map((message) => toInboundMessage(message));
        const state = createStreamState();
        let outcome;
        try {
            outcome = await this.pool.run({
                messages: inbound,
                model: { provider: parsed.provider, modelId: parsed.modelId },
                modelKey: parsed.lookupId,
                cwd: '',
                token,
                onEvent: (event) => {
                    for (const chunk of applyAgentEvent(event, state)) {
                        progress.report(new vscode.LanguageModelTextPart(chunk));
                    }
                },
            });
        } catch (error) {
            if (error instanceof PiCancelledError || token.isCancellationRequested) {
                debug('Pi request cancelled');
                return;
            }
            throw error;
        }

        for (const limitation of outcome.limitations) {
            progress.report(new vscode.LanguageModelTextPart(`[provider limitation] ${limitation}`));
        }
        for (const limitation of state.limitations) {
            if (!outcome.limitations.includes(limitation)) {
                progress.report(new vscode.LanguageModelTextPart(`[provider limitation] ${limitation}`));
            }
        }

        if (token.isCancellationRequested) {
            return;
        }

        if (outcome.duplicate || !state.streamedText) {
            const text = await outcome.getLastAssistantText();
            if (text) {
                if (!state.streamedText) {
                    progress.report(new vscode.LanguageModelTextPart(text));
                }
            } else if (outcome.duplicate) {
                progress.report(new vscode.LanguageModelTextPart(
                    'This prompt matches the Pi session that is already running or that just finished, so it was not sent again. Pi did not have assistant text to repeat.'
                ));
            } else if (!state.reportedToolActivity) {
                throw new PiError(
                    'EMPTY',
                    state.agentError
                        ? `Pi agent error: ${state.agentError}`
                        : 'Pi finished without any response text. Check the Pi Agent output channel.'
                );
            }
        }

        this.pool.noteTurn(outcome);
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        if (typeof text === 'string') {
            return Math.ceil(text.length / 4);
        }
        const inbound = toInboundMessage(text);
        let chars = 0;
        let images = 0;
        const walk = (part: InboundPart) => {
            if (part.text) {
                chars += part.text.length;
            }
            if (part.kind === 'image') {
                images++;
            }
            for (const child of part.resultParts ?? []) {
                walk(child);
            }
        };
        for (const part of inbound.parts) {
            walk(part);
        }
        return Math.ceil(chars / 4) + images * 1000;
    }

    private toModelInformation(model: PiModelInfo): vscode.LanguageModelChatInformation {
        const id = `${model.provider}:${model.id}`;
        this.modelProviders.set(id, model.provider);
        const family = model.id.split('-').slice(0, -1).join('-') || model.id;
        // 1.109 hid models unless this was true. 1.144.1 copies the field with no
        // proposed-API check and treats omission as visible. It is set explicitly
        // so a 1.109 host and a 1.144 host see the same value. toolCalling stays false.
        const info: vscode.LanguageModelChatInformation & { isUserSelectable: true } = {
            id,
            name: `pi /${model.provider}/${model.id}`,
            family,
            version: model.id,
            maxInputTokens: model.contextWindow,
            maxOutputTokens: model.maxTokens,
            tooltip: MODEL_TOOLTIP,
            detail: MODEL_DETAIL,
            capabilities: modelCapabilities(),
            isUserSelectable: true,
        };
        return info;
    }
}

function recordFromInfo(info: vscode.LanguageModelChatInformation): RegisteredModelRecord {
    const extra = info as vscode.LanguageModelChatInformation & {
        isUserSelectable?: boolean;
        targetChatSessionType?: string;
        isBYOK?: boolean;
        category?: string | { label?: string };
    };
    const category = typeof extra.category === 'string' ? extra.category : extra.category?.label;
    return {
        id: info.id,
        name: info.name,
        family: info.family,
        version: info.version,
        maxInputTokens: info.maxInputTokens,
        maxOutputTokens: info.maxOutputTokens,
        toolCalling: info.capabilities.toolCalling === true,
        imageInput: info.capabilities.imageInput === true,
        isUserSelectable: extra.isUserSelectable,
        targetChatSessionType: extra.targetChatSessionType,
        isBYOK: extra.isBYOK,
        category,
    };
}

function toInboundMessage(message: vscode.LanguageModelChatRequestMessage): InboundMessage {
    const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
    return {
        role,
        name: message.name,
        parts: message.content.map((part) => toPart(part)),
    };
}

function toPart(part: unknown): InboundPart {
    if (typeof part === 'string') {
        return { kind: 'text', text: part };
    }
    if (part instanceof vscode.LanguageModelTextPart) {
        return { kind: 'text', text: part.value };
    }
    if (part instanceof vscode.LanguageModelToolCallPart) {
        return {
            kind: 'tool-call',
            toolName: part.name,
            toolCallId: part.callId,
            input: part.input,
        };
    }
    if (part instanceof vscode.LanguageModelToolResultPart) {
        return {
            kind: 'tool-result',
            toolCallId: part.callId,
            resultParts: part.content.map((child) => toPart(child)),
        };
    }
    if (part instanceof vscode.LanguageModelPromptTsxPart) {
        return {
            kind: 'unknown',
            label: 'prompt-tsx',
            text: safeStringify(part.value),
        };
    }
    if (isBinaryPart(part)) {
        if (part.mimeType.startsWith('image/')) {
            return { kind: 'image', mimeType: part.mimeType, data: part.data };
        }
        return { kind: 'data', mimeType: part.mimeType, data: part.data };
    }
    const label = part && typeof part === 'object' && 'constructor' in part
        ? part.constructor.name
        : typeof part;
    if (label === 'LanguageModelThinkingPart' && part && typeof part === 'object' && 'value' in part && typeof part.value === 'string') {
        return { kind: 'thinking', text: part.value, label };
    }
    return {
        kind: 'unknown',
        label,
        text: safeStringify(part),
    };
}

function isBinaryPart(part: unknown): part is { mimeType: string; data: Uint8Array } {
    return !!part
        && typeof part === 'object'
        && 'mimeType' in part
        && typeof part.mimeType === 'string'
        && 'data' in part
        && part.data instanceof Uint8Array;
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
