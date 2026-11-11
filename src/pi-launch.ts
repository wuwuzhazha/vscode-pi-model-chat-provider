import * as path from 'node:path';

/**
 * How to start Pi without a shell.
 *
 * On Windows, `pi` from npm is not a PE executable. The directory contains
 * `pi.cmd`, `pi.ps1`, and an extensionless `pi` script. `child_process.spawn`
 * without `shell: true` reports ENOENT for those, which is the "Pi CLI not
 * found at pi" failure even when PowerShell can run `pi --version`.
 *
 * This resolver does not run cmd.exe or arbitrary shim text. It only accepts
 * a real `.exe`, or a recognized npm shim whose script path stays inside the
 * shim directory, and then spawns `node.exe` with that script as an argument.
 */

export interface PiLaunch {
    /** Executable passed to spawn. Never cmd.exe. */
    command: string;
    /** Arguments placed before the caller's arguments, such as the cli.js path. */
    prefixArgs: string[];
    /** File that satisfied pi.binaryPath (the shim or the executable). */
    source: string;
    summary: string;
}

export type PiLaunchResult =
    | { ok: true; launch: PiLaunch }
    | { ok: false; reason: 'missing' | 'unlaunchable'; message: string };

export interface PiLaunchIo {
    exists(filePath: string): boolean;
    /**
     * Read a candidate shim. `undefined` if the file cannot be read.
     * `head` is the first two bytes, used to recognize a PE executable.
     */
    read(filePath: string): { text: string; head: string; tooLarge?: boolean } | undefined;
}

const SHIM_READ_LIMIT = 65_536;
const NODE_WALK_LIMIT = 8;

export function resolvePiLaunch(options: {
    binaryPath: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    io: PiLaunchIo;
}): PiLaunchResult {
    const pathApi = options.platform === 'win32' ? path.win32 : path.posix;
    const requested = options.binaryPath.trim();
    if (!requested) {
        return { ok: false, reason: 'missing', message: 'pi.binaryPath is empty.' };
    }
    if (isPathLike(requested, options.platform)) {
        const full = pathApi.resolve(options.cwd, requested);
        return resolveExplicit(full, requested, options, pathApi);
    }
    return resolveOnPath(requested, options, pathApi);
}

function resolveExplicit(
    full: string,
    requested: string,
    options: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; io: PiLaunchIo },
    pathApi: path.PlatformPath
): PiLaunchResult {
    if (!options.io.exists(full)) {
        return {
            ok: false,
            reason: 'missing',
            message: missingMessage(requested, options.env, options.platform, `The file "${full}" does not exist.`),
        };
    }
    if (options.platform !== 'win32') {
        return direct(full, full);
    }
    return launchWindowsFile(full, requested, options, pathApi);
}

function resolveOnPath(
    name: string,
    options: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; io: PiLaunchIo },
    pathApi: path.PlatformPath
): PiLaunchResult {
    const dirs = pathDirs(options.env, options.platform);
    if (options.platform !== 'win32') {
        for (const dir of dirs) {
            const candidate = pathApi.join(dir, name);
            if (options.io.exists(candidate)) {
                return direct(candidate, candidate);
            }
        }
        return { ok: false, reason: 'missing', message: missingMessage(name, options.env, options.platform) };
    }

    const unlaunchable: string[] = [];
    for (const dir of dirs) {
        const exe = pathApi.join(dir, `${name}.exe`);
        if (options.io.exists(exe)) {
            return direct(exe, exe);
        }
        const shims = ['.cmd', '', '.ps1', '.bat'].map((ext) => pathApi.join(dir, ext ? `${name}${ext}` : name));
        let sawFile = false;
        for (const shim of shims) {
            if (!options.io.exists(shim)) {
                continue;
            }
            sawFile = true;
            const launched = launchWindowsFile(shim, name, options, pathApi);
            if (launched.ok || launched.reason === 'missing') {
                return launched;
            }
            if (isBrokenShim(launched.message)) {
                return launched;
            }
        }
        if (sawFile) {
            unlaunchable.push(...shims.filter((shim) => options.io.exists(shim)));
        }
    }
    if (unlaunchable.length > 0) {
        return { ok: false, reason: 'unlaunchable', message: unlaunchableMessage(name, unique(unlaunchable)) };
    }
    return { ok: false, reason: 'missing', message: missingMessage(name, options.env, options.platform) };
}

function launchWindowsFile(
    file: string,
    requested: string,
    options: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; io: PiLaunchIo },
    pathApi: path.PlatformPath
): PiLaunchResult {
    const ext = pathApi.extname(file).toLowerCase();
    if (ext === '.exe' || ext === '.com') {
        return direct(file, file);
    }
    if (ext === '.js') {
        return launchCliJs(file, requested, options, pathApi);
    }
    const body = options.io.read(file);
    if (!body) {
        return {
            ok: false,
            reason: 'unlaunchable',
            message: `Found "${file}" for "${requested}", but it could not be read. It was not executed.`,
        };
    }
    if (body.tooLarge) {
        return { ok: false, reason: 'unlaunchable', message: unlaunchableMessage(requested, [file]) };
    }
    if (!ext && body.head === 'MZ') {
        return direct(file, file);
    }
    const relative = parseNpmShim(body.text);
    if (!relative) {
        return { ok: false, reason: 'unlaunchable', message: unlaunchableMessage(requested, [file]) };
    }
    const script = pathApi.resolve(pathApi.dirname(file), ...relative);
    if (!isInside(pathApi, pathApi.dirname(file), script)) {
        return {
            ok: false,
            reason: 'unlaunchable',
            message: `Shim "${file}" points outside its directory ("${script}"). It was not executed.`,
        };
    }
    if (!options.io.exists(script)) {
        return {
            ok: false,
            reason: 'unlaunchable',
            message:
                `Npm shim "${file}" points at "${script}", which does not exist. ` +
                'The shim was not run through cmd.exe. Reinstall is not required if Pi already works in a terminal: ' +
                'set pi.binaryPath to the full path of that cli.js.',
        };
    }
    const node = resolveNode(pathApi.dirname(file), options, pathApi);
    if (!node) {
        const adjacent = pathApi.join(pathApi.dirname(file), 'node.exe');
        return {
            ok: false,
            reason: 'unlaunchable',
            message:
                `Npm shim "${file}" points at "${script}", but "${adjacent}" does not exist and node.exe was not found on the Extension Host PATH. ` +
                'The shim was not executed.',
        };
    }
    return {
        ok: true,
        launch: {
            command: node,
            prefixArgs: [script],
            source: file,
            summary: `Pi command "${requested}" resolved from npm shim "${file}" to "${node}" "${script}".`,
        },
    };
}

function launchCliJs(
    script: string,
    requested: string,
    options: { env: NodeJS.ProcessEnv; io: PiLaunchIo },
    pathApi: path.PlatformPath
): PiLaunchResult {
    const node = resolveNode(pathApi.dirname(script), options, pathApi);
    if (!node) {
        return {
            ok: false,
            reason: 'unlaunchable',
            message:
                `Pi cli.js "${script}" was found, but node.exe was not next to that Node install and was not on the Extension Host PATH. ` +
                'It was not started through a shell.',
        };
    }
    return {
        ok: true,
        launch: {
            command: node,
            prefixArgs: [script],
            source: script,
            summary: `Pi command "${requested}" resolved to "${node}" "${script}".`,
        },
    };
}

function resolveNode(
    startDir: string,
    options: { env: NodeJS.ProcessEnv; io: PiLaunchIo },
    pathApi: path.PlatformPath
): string | undefined {
    let dir = startDir;
    for (let i = 0; i < NODE_WALK_LIMIT; i++) {
        const adjacent = pathApi.join(dir, 'node.exe');
        if (options.io.exists(adjacent)) {
            return adjacent;
        }
        const parent = pathApi.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    for (const entry of pathDirs(options.env, 'win32')) {
        const exe = pathApi.join(entry, 'node.exe');
        if (options.io.exists(exe)) {
            return exe;
        }
    }
    return undefined;
}

/**
 * Recognized npm shims only. Returns the `node_modules/...js` path relative
 * to the shim directory. Anything else is refused.
 */
export function parseNpmShim(text: string): string[] | undefined {
    const source = text.replace(/^\uFEFF/, '');
    const found = new Set<string>();
    const patterns = [
        /%~?dp0%\\(node_modules\\[^"\r\n]+\.js)/gi,
        /\$(?:\{basedir\}|basedir)[/\\](node_modules[/\\][^"'\s]+\.js)/gi,
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            const parts = match[1].split(/[\\/]/).filter((part) => part.length > 0);
            if (parts.some((part) => part === '.' || part === '..')) {
                return undefined;
            }
            if (parts[0] !== 'node_modules' || !parts[parts.length - 1].endsWith('.js')) {
                return undefined;
            }
            found.add(parts.join('/'));
        }
    }
    if (found.size !== 1) {
        return undefined;
    }
    return [...found][0].split('/');
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

function isBrokenShim(message: string): boolean {
    return message.includes('points at') || message.includes('points outside');
}

function direct(command: string, source: string): PiLaunchResult {
    return {
        ok: true,
        launch: {
            command,
            prefixArgs: [],
            source,
            summary: `Pi command resolved to executable "${command}".`,
        },
    };
}

function isPathLike(value: string, platform: NodeJS.Platform): boolean {
    if (platform === 'win32') {
        return path.win32.isAbsolute(value) || value.includes('\\') || value.includes('/');
    }
    return value.includes('/');
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
    const raw = platform === 'win32' ? (env.Path ?? env.PATH ?? '') : (env.PATH ?? '');
    const delimiter = platform === 'win32' ? ';' : ':';
    return raw.split(delimiter).map((entry) => entry.trim().replace(/^"|"$/g, '')).filter((entry) => entry.length > 0);
}

function isInside(pathApi: path.PlatformPath, parent: string, child: string): boolean {
    const relative = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
}

function missingMessage(requested: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, detail?: string): string {
    const searched = pathDirs(env, platform);
    return [
        `Pi command "${requested}" was not found.`,
        detail,
        `Extension Host PATH (${searched.length} director${searched.length === 1 ? 'y' : 'ies'}): ${searched.join(platform === 'win32' ? ';' : ':') || '(empty)'}.`,
        'If `pi --version` works in PowerShell, that PATH may come from the shell profile and is not visible to VS Code. Set pi.binaryPath to the full path of pi.cmd or of Pi\'s cli.js.',
        'This extension does not start npm shims through cmd.exe.',
    ].filter((line) => !!line).join(' ');
}

function unlaunchableMessage(requested: string, files: string[]): string {
    return [
        `Found ${files.map((file) => `"${file}"`).join(', ')} for Pi command "${requested}", but it is not a Windows executable and not a recognized npm shim.`,
        'A recognized shim is the standard npm pi.cmd, pi.ps1, or extensionless pi script that runs node.exe with a cli.js under that directory.',
        'Refusing to run it with a shell. Set pi.binaryPath to the full path of that cli.js if Pi already works in a terminal.',
    ].join(' ');
}

export { SHIM_READ_LIMIT };
