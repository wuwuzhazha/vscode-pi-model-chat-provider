import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CancelToken } from '../src/cancel-token.js';
import type { InboundMessage, InboundPart } from '../src/messages.js';
import type { Logger } from '../src/logger.js';
import type { ResolvedPiConfig } from '../src/types.js';

const mockPi = path.join(repoRoot(), 'test', 'fixtures', 'mock-pi.mjs');

export class FakeToken implements CancelToken {
    private listeners: Array<() => void> = [];
    isCancellationRequested = false;

    onCancellationRequested(listener: () => void): { dispose(): void } {
        if (this.isCancellationRequested) {
            listener();
        }
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter((item) => item !== listener);
            },
        };
    }

    cancel(): void {
        if (this.isCancellationRequested) {
            return;
        }
        this.isCancellationRequested = true;
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

export function memoryLogger(): Logger & { lines: string[] } {
    const lines: string[] = [];
    return {
        lines,
        info(message: string) {
            lines.push(message);
        },
        debug(message: string) {
            lines.push(message);
        },
    };
}

export async function makeWorkspace(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), 'pi-provider-'));
}

export async function installMockBinary(dir: string): Promise<string> {
    const binary = path.join(dir, 'pi');
    await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${mockPi}" "$@"\n`, 'utf8');
    await chmod(binary, 0o755);
    return binary;
}

export function testConfig(cwd: string, binaryPath: string, overrides: Partial<ResolvedPiConfig> = {}): ResolvedPiConfig {
    return {
        binaryPath,
        workingDirectory: '',
        cwd,
        autoRestart: false,
        maxRestartAttempts: 2,
        additionalArgs: [],
        commandTimeoutMs: 2000,
        hungRequestTimeoutMs: 0,
        shutdownGraceMs: 400,
        persistSessions: false,
        sessionDirectory: '',
        maxSessions: 4,
        sessionIdleTimeoutMs: 0,
        debug: false,
        ...overrides,
    };
}

export function user(text: string, extra: InboundPart[] = []): InboundMessage {
    return { role: 'user', parts: [{ kind: 'text', text }, ...extra] };
}

export function assistant(text: string): InboundMessage {
    return { role: 'assistant', parts: [{ kind: 'text', text }] };
}

export function repoRoot(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!(await predicate())) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
