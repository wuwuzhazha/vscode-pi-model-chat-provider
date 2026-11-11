/**
 * Shared configuration for the Pi language model provider.
 * Original types by tintinweb; extended for this fork.
 */

export interface PiConfig {
    binaryPath: string;
    /** Explicit working directory. Empty means the first workspace folder. */
    workingDirectory: string;
    autoRestart: boolean;
    maxRestartAttempts: number;
    additionalArgs: string[];
    /** Timeout for a single RPC command acceptance, in milliseconds. */
    commandTimeoutMs: number;
    /**
     * Inactivity timeout for a running prompt, in milliseconds.
     * 0 disables it. Streaming output resets the timer, so a long task is not
     * cut off just because it exceeds a fixed wall-clock cap.
     */
    hungRequestTimeoutMs: number;
    /** How long to wait for Pi to exit after stdin is closed and SIGTERM. */
    shutdownGraceMs: number;
    /** When false, Pi is started with --no-session and transcripts stay in memory. */
    persistSessions: boolean;
    /** Empty uses <workspace>/.pi/vscode-lm-sessions when persistence is on. */
    sessionDirectory: string;
    maxSessions: number;
    /** Idle session lifetime, in milliseconds. */
    sessionIdleTimeoutMs: number;
    debug: boolean;
}

export interface ResolvedPiConfig extends PiConfig {
    cwd: string;
    sessionDir?: string;
}
