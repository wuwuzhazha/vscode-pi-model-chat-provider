/**
 * VS Code may pass `pi/provider:model-id`. Only a literal `pi/` prefix is a
 * vendor prefix. Model ids such as `openrouter:anthropic/claude-3.5-sonnet`
 * contain slashes and must stay intact.
 */
export function stripVendorPrefix(rawId: string): string {
    if (rawId.startsWith('pi/')) {
        return rawId.slice(3);
    }
    return rawId;
}

export interface ParsedPiModel {
    lookupId: string;
    provider: string;
    modelId: string;
}

export function parseRegisteredModelId(
    rawId: string,
    providers: ReadonlyMap<string, string>
): ParsedPiModel {
    const lookupId = stripVendorPrefix(rawId);
    const provider = providers.get(lookupId);
    if (!provider) {
        const available = Array.from(providers.keys());
        throw new Error(
            `Unknown model: "${lookupId}". ` +
            'This model was not registered by the Pi provider. ' +
            `Available Pi models: ${available.join(', ') || '(none)'}`
        );
    }
    const prefix = `${provider}:`;
    if (!lookupId.startsWith(prefix) || lookupId.length === prefix.length) {
        throw new Error(
            `Invalid model id "${lookupId}" for provider "${provider}". Expected "${prefix}<model-id>".`
        );
    }
    return {
        lookupId,
        provider,
        modelId: lookupId.slice(prefix.length),
    };
}
