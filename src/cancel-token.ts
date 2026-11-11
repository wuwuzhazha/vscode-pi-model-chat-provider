/**
 * Minimal cancellation token so the Pi process layer can be tested without
 * importing the VS Code extension API.
 */
export interface CancelSubscription {
    dispose(): void;
}

export interface CancelToken {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): CancelSubscription;
}
