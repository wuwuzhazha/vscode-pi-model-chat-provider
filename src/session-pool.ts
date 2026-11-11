import * as vscode from 'vscode';
import { isRecord } from './protocol/events.js';
import { PiProcess, type PiModelInfo } from './pi-process.js';
import { SessionCoordinator, type TurnOutcome, type TurnRequest } from './session-coordinator.js';
import { SessionIndex } from './session-index.js';
import type { Logger } from './logger.js';
import type { PiConfig, ResolvedPiConfig } from './types.js';
import type { PiUi } from './ui-protocol.js';
import { resolveSessionDirectory, resolveWorkingDirectory } from './workspace-policy.js';

const MODEL_CACHE_MS = 30_000;

export interface PoolEnvironment {
    isTrusted(): boolean;
    workspaceFolders(): readonly string[];
}

/**
 * VS Code-facing session pool. Transcript identity lives in SessionCoordinator.
 * The status bar is local UI and is not part of the RPC protocol.
 */
export class SessionPool {
    private readonly coordinator: SessionCoordinator;
    private metadata: PiProcess | undefined;
    private modelCache: PiModelInfo[] | undefined;
    private modelCacheTime = 0;
    private statusBar: vscode.StatusBarItem | undefined;
    private statusBarHideTimer: NodeJS.Timeout | undefined;
    private resolved: ResolvedPiConfig | undefined;
    private resolveError: unknown;

    constructor(
        private readonly config: PiConfig,
        private readonly environment: PoolEnvironment,
        private readonly ui: PiUi,
        private readonly log: Logger
    ) {
        try {
            this.resolved = this.resolveConfig();
        } catch (error) {
            this.resolveError = error;
        }
        const index = this.resolved?.sessionDir ? new SessionIndex(this.resolved.sessionDir) : undefined;
        this.coordinator = new SessionCoordinator({
            createClient: () => this.createProcess(this.requireConfig()),
            maxSessions: config.maxSessions,
            idleTimeoutMs: config.sessionIdleTimeoutMs,
            index,
        });
    }

    run(request: TurnRequest): Promise<TurnOutcome> {
        const resolved = this.requireConfig();
        return this.coordinator.run({ ...request, cwd: resolved.cwd });
    }

    noteTurn(outcome: TurnOutcome): void {
        void this.updateStatusBar(outcome);
    }

    async getAvailableModels(): Promise<PiModelInfo[]> {
        if (this.modelCache && Date.now() - this.modelCacheTime < MODEL_CACHE_MS) {
            return this.modelCache;
        }
        const resolved = this.requireConfig();
        if (!this.metadata || !this.metadata.alive) {
            this.metadata = this.createProcess({ ...resolved, sessionDir: undefined, persistSessions: false });
        }
        const models = await this.metadata.getAvailableModels();
        this.modelCache = models;
        this.modelCacheTime = Date.now();
        return models;
    }

    async dispose(): Promise<void> {
        if (this.statusBarHideTimer) {
            clearTimeout(this.statusBarHideTimer);
            this.statusBarHideTimer = undefined;
        }
        this.statusBar?.dispose();
        this.statusBar = undefined;
        this.modelCache = undefined;
        if (this.metadata) {
            await this.metadata.shutdown();
            this.metadata = undefined;
        }
        await this.coordinator.dispose();
    }

    private requireConfig(): ResolvedPiConfig {
        if (this.resolveError) {
            throw this.resolveError;
        }
        if (!this.resolved) {
            this.resolved = this.resolveConfig();
        }
        return this.resolved;
    }

    private createProcess(config: ResolvedPiConfig): PiProcess {
        return new PiProcess(config, this.ui, this.log, () => this.environment.isTrusted());
    }

    private resolveConfig(): ResolvedPiConfig {
        const folders = this.environment.workspaceFolders();
        const cwd = resolveWorkingDirectory(this.config.workingDirectory, folders);
        const sessionDir = resolveSessionDirectory({
            persist: this.config.persistSessions,
            configuredDir: this.config.sessionDirectory,
            workspaceFolders: folders,
        });
        return { ...this.config, cwd, sessionDir };
    }

    private async updateStatusBar(outcome: TurnOutcome): Promise<void> {
        try {
            const [stats, state] = await Promise.all([
                outcome.getSessionStats(),
                outcome.getState(),
            ]);
            const model = isRecord(state.model) ? state.model : {};
            const tokens = isRecord(stats.tokens) ? stats.tokens : {};
            const contextWindow = typeof model.contextWindow === 'number' ? model.contextWindow : 200000;
            const totalTokens = typeof tokens.total === 'number' ? tokens.total : 0;
            const utilization = contextWindow > 0 ? Math.round((totalTokens / contextWindow) * 100) : 0;
            if (!this.statusBar) {
                this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
                this.statusBar.name = 'Pi Context';
            }
            this.statusBar.text = `$(pi-logo) ${utilization}%`;
            const cost = typeof stats.cost === 'number' ? stats.cost.toFixed(4) : '0.0000';
            this.statusBar.tooltip = [
                'Pi context (in the Pi process)',
                `Used: ${formatTokens(totalTokens)} / ${formatTokens(contextWindow)} (${utilization}%)`,
                `Input: ${formatTokens(numberField(tokens, 'input'))}`,
                `Output: ${formatTokens(numberField(tokens, 'output'))}`,
                `Cache read: ${formatTokens(numberField(tokens, 'cacheRead'))}`,
                `Cost reported by Pi: $${cost}`,
                'Pi tools are not VS Code tools. This percentage is Pi\'s own session accounting.',
            ].join('\n');
            this.statusBar.show();
            if (this.statusBarHideTimer) {
                clearTimeout(this.statusBarHideTimer);
            }
            this.statusBarHideTimer = setTimeout(() => this.statusBar?.hide(), 5 * 60 * 1000);
        } catch (error) {
            this.log.info(`Status bar update failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

function numberField(record: Record<string, unknown>, key: string): number {
    const value = record[key];
    return typeof value === 'number' ? value : 0;
}

function formatTokens(tokens: number): string {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}k`;
    }
    return String(tokens);
}
