import * as path from 'node:path';
import { PiStartupError, PiTrustError } from './errors.js';

const BLOCKED_ADDITIONAL_ARGS = new Set([
    '-s',
    '--mode',
    '--session',
    '--session-dir',
    '--no-session',
    '--resume',
    '--continue',
    '--fork',
]);

/**
 * Untrusted workspaces must not spawn Pi. Pi can read and execute inside the
 * working directory with the user's credentials.
 */
export function assertWorkspaceTrusted(trusted: boolean): void {
    if (trusted) {
        return;
    }
    throw new PiTrustError(
        'This workspace is not trusted, so the Pi language model provider will not start Pi or run tools. ' +
        'Trust the workspace in VS Code before using a Pi model. ' +
        'Trusting the workspace lets Pi read and modify files according to Pi\'s own permissions; ' +
        'it is not the same as approving an individual VS Code tool call.'
    );
}

/**
 * additionalArgs are appended to `pi --mode rpc`. Flags that leave RPC mode
 * or choose a session file are rejected so transcripts are not written
 * somewhere the persistence setting did not ask for.
 */
export function assertSafeAdditionalArgs(args: readonly string[]): void {
    for (const arg of args) {
        const name = arg.split('=')[0];
        if (BLOCKED_ADDITIONAL_ARGS.has(name)) {
            throw new PiStartupError(
                `pi.additionalArgs contains "${arg}", which can change RPC mode or where Pi stores sessions. ` +
                'Remove it. Keep sessions in memory with the default settings, or opt in with pi.persistSessions ' +
                'and pi.sessionDirectory (a directory inside this workspace).'
            );
        }
    }
}

export function isPathInside(parent: string, target: string): boolean {
    const root = path.resolve(parent);
    const child = path.resolve(target);
    const relative = path.relative(root, child);
    if (relative === '') {
        return true;
    }
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function resolveWorkingDirectory(
    configured: string,
    workspaceFolders: readonly string[]
): string {
    const explicit = configured.trim();
    if (explicit) {
        const base = workspaceFolders[0] ?? process.cwd();
        return path.resolve(base, explicit);
    }
    if (workspaceFolders[0]) {
        return workspaceFolders[0];
    }
    throw new PiStartupError(
        'No workspace folder is open and pi.workingDirectory is empty. ' +
        'Open a trusted folder, or set pi.workingDirectory to the directory Pi may read and modify. ' +
        'Pi tools run in that directory; this provider does not switch directories per multi-root folder.'
    );
}

/**
 * Session files are opt-in and must stay inside a workspace folder.
 * Returns undefined when persistence is off (`--no-session`).
 */
export function resolveSessionDirectory(options: {
    persist: boolean;
    configuredDir: string;
    workspaceFolders: readonly string[];
}): string | undefined {
    if (!options.persist) {
        return undefined;
    }
    if (options.workspaceFolders.length === 0) {
        throw new PiStartupError(
            'pi.persistSessions writes Pi transcripts into a workspace folder. ' +
            'Open a folder, or turn pi.persistSessions off to keep the conversation in memory only.'
        );
    }
    const configured = options.configuredDir.trim();
    const target = configured
        ? path.resolve(options.workspaceFolders[0], configured)
        : path.join(options.workspaceFolders[0], '.pi', 'vscode-lm-sessions');
    const inside = options.workspaceFolders.some((folder) => isPathInside(folder, target));
    if (!inside) {
        throw new PiStartupError(
            `Refusing to store Pi sessions outside the workspace (${target}). ` +
            'Leave pi.sessionDirectory empty to use <workspace>/.pi/vscode-lm-sessions, ' +
            'or set it to a directory inside a trusted workspace folder. ' +
            'Session files contain prompts, tool output, and file contents Pi reads.'
        );
    }
    return target;
}

export function buildRpcArgs(options: {
    additionalArgs: readonly string[];
    sessionDir?: string;
}): string[] {
    assertSafeAdditionalArgs(options.additionalArgs);
    const args = ['--mode', 'rpc'];
    if (options.sessionDir) {
        args.push('--session-dir', options.sessionDir);
    } else {
        args.push('--no-session');
    }
    args.push(...options.additionalArgs);
    return args;
}
