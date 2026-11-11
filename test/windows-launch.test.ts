/**
 * MOCKED Windows launch tests.
 * They run on every OS. The filesystem is an in-memory map of Windows paths.
 * Nothing is executed, and cmd.exe is never a launch command.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNpmShim, resolvePiLaunch, type PiLaunchIo } from '../src/pi-launch.js';

const CLI = 'node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js';
const ROOT = 'C:\\Program Files\\node-v24\\';
const NODE = `${ROOT}node.exe`;
const CMD = `${ROOT}pi.cmd`;
const PS1 = `${ROOT}pi.ps1`;
const BARE = `${ROOT}pi`;
const SCRIPT = `${ROOT}${CLI}`;

const CMD_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*
`;

const PS1_SHIM = `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
& "$basedir/node.exe"  "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" $args
`;

const BARE_SHIM = `#!/bin/sh
basedir=$(dirname "$0")
exec "$basedir/node"  "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"
`;

function files(present: Record<string, string | true>): PiLaunchIo {
    const keys = new Map(Object.keys(present).map((file) => [normalize(file), present[file]]));
    return {
        exists(filePath) {
            return keys.has(normalize(filePath));
        },
        read(filePath) {
            const value = keys.get(normalize(filePath));
            if (typeof value !== 'string') {
                return undefined;
            }
            return { text: value, head: value.slice(0, 2) };
        },
    };
}

function normalize(filePath: string): string {
    return filePath.replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
}

function windowsEnv(pathValue: string): NodeJS.ProcessEnv {
    return { Path: pathValue };
}

test('mocked Windows: bare pi on PATH resolves the npm cmd shim to node.exe plus cli.js', () => {
    const resolved = resolvePiLaunch({
        binaryPath: 'pi',
        cwd: 'C:\\work',
        env: windowsEnv(ROOT),
        platform: 'win32',
        io: files({
            [NODE]: true,
            [CMD]: CMD_SHIM,
            [PS1]: PS1_SHIM,
            [BARE]: BARE_SHIM,
            [SCRIPT]: true,
        }),
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
        return;
    }
    assert.equal(resolved.launch.command, NODE);
    assert.deepEqual(resolved.launch.prefixArgs, [SCRIPT]);
    assert.equal(resolved.launch.source, CMD);
    assert.equal(resolved.launch.command.includes(' '), true);
    assert.equal(resolved.launch.prefixArgs[0].includes(' '), true);
    assert.equal(resolved.launch.prefixArgs.length, 1);
    assert.equal(resolved.launch.command.toLowerCase().endsWith('cmd.exe'), false);
});

test('mocked Windows: a configured pi.cmd path is used even when PATH points somewhere else', () => {
    const resolved = resolvePiLaunch({
        binaryPath: CMD,
        cwd: 'C:\\work',
        env: windowsEnv('D:\\unrelated'),
        platform: 'win32',
        io: files({ [NODE]: true, [CMD]: CMD_SHIM, [SCRIPT]: true }),
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
        return;
    }
    assert.equal(resolved.launch.source, CMD);
    assert.equal(resolved.launch.command, NODE);
    assert.deepEqual(resolved.launch.prefixArgs, [SCRIPT]);
});

test('mocked Windows: pi.ps1 and the extensionless shim resolve to the same node and cli.js', () => {
    for (const source of [PS1, BARE]) {
        const text = source === PS1 ? PS1_SHIM : BARE_SHIM;
        const resolved = resolvePiLaunch({
            binaryPath: source,
            cwd: 'C:\\work',
            env: windowsEnv(''),
            platform: 'win32',
            io: files({ [NODE]: true, [source]: text, [SCRIPT]: true }),
        });
        assert.equal(resolved.ok, true, source);
        if (!resolved.ok) {
            continue;
        }
        assert.equal(resolved.launch.command, NODE);
        assert.deepEqual(resolved.launch.prefixArgs, [SCRIPT]);
    }
});

test('mocked Windows: a real pi.exe is launched directly and wins over a shim', () => {
    const exe = `${ROOT}pi.exe`;
    const resolved = resolvePiLaunch({
        binaryPath: 'pi',
        cwd: 'C:\\work',
        env: windowsEnv(ROOT),
        platform: 'win32',
        io: files({ [exe]: true, [CMD]: CMD_SHIM, [SCRIPT]: true, [NODE]: true }),
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
        return;
    }
    assert.equal(resolved.launch.command, exe);
    assert.deepEqual(resolved.launch.prefixArgs, []);
});

test('mocked Windows: configured cli.js uses the node.exe above node_modules, not node.cmd', () => {
    const resolved = resolvePiLaunch({
        binaryPath: SCRIPT,
        cwd: 'C:\\work',
        env: windowsEnv('D:\\other'),
        platform: 'win32',
        io: files({
            [SCRIPT]: true,
            [NODE]: true,
            'D:\\other\\node.cmd': '@ECHO off',
            'D:\\other\\node.exe': true,
        }),
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
        return;
    }
    assert.equal(resolved.launch.command, NODE);
    assert.deepEqual(resolved.launch.prefixArgs, [SCRIPT]);
});

test('mocked Windows: missing pi reports the Extension Host PATH and does not say the shim was executed', () => {
    const resolved = resolvePiLaunch({
        binaryPath: 'pi',
        cwd: 'C:\\work',
        env: windowsEnv('C:\\Windows\\system32'),
        platform: 'win32',
        io: files({}),
    });
    assert.equal(resolved.ok, false);
    if (resolved.ok) {
        return;
    }
    assert.equal(resolved.reason, 'missing');
    assert.match(resolved.message, /was not found/);
    assert.match(resolved.message, /C:\\Windows\\system32/);
    assert.match(resolved.message, /PowerShell/);
    assert.match(resolved.message, /does not start npm shims through cmd\.exe/);
});

test('mocked Windows: an arbitrary cmd file is unlaunchable and is not turned into a shell command', () => {
    const resolved = resolvePiLaunch({
        binaryPath: 'pi',
        cwd: 'C:\\work',
        env: windowsEnv(ROOT),
        platform: 'win32',
        io: files({ [CMD]: '@ECHO off\r\ncmd.exe /c calc.exe\r\n' }),
    });
    assert.equal(resolved.ok, false);
    if (resolved.ok) {
        return;
    }
    assert.equal(resolved.reason, 'unlaunchable');
    assert.match(resolved.message, /not a recognized npm shim/);
    assert.match(resolved.message, /Refusing to run it with a shell/);
    assert.equal(resolved.message.includes('calc.exe'), false);
});

test('mocked Windows: a shim that escapes its directory is refused', () => {
    const text = '"%dp0%\\node_modules\\..\\..\\Windows\\system32\\evil.js"';
    assert.equal(parseNpmShim(text), undefined);
    const resolved = resolvePiLaunch({
        binaryPath: CMD,
        cwd: 'C:\\work',
        env: windowsEnv(''),
        platform: 'win32',
        io: files({ [CMD]: text, [NODE]: true }),
    });
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
        assert.equal(resolved.reason, 'unlaunchable');
    }
});

test('mocked Windows: a shim whose cli.js is missing names the script and does not fall through to a shell', () => {
    const resolved = resolvePiLaunch({
        binaryPath: CMD,
        cwd: 'C:\\work',
        env: windowsEnv(''),
        platform: 'win32',
        io: files({ [CMD]: CMD_SHIM, [NODE]: true }),
    });
    assert.equal(resolved.ok, false);
    if (resolved.ok) {
        return;
    }
    assert.equal(resolved.reason, 'unlaunchable');
    assert.match(resolved.message, /does not exist/);
    assert.match(resolved.message, /cli\.js/);
});

test('mocked Linux: a bare name on PATH stays a direct executable', () => {
    const resolved = resolvePiLaunch({
        binaryPath: 'pi',
        cwd: '/work',
        env: { PATH: '/opt/bin:/usr/bin' },
        platform: 'linux',
        io: {
            exists: (filePath) => filePath === '/opt/bin/pi',
            read: () => undefined,
        },
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
        return;
    }
    assert.equal(resolved.launch.command, '/opt/bin/pi');
    assert.deepEqual(resolved.launch.prefixArgs, []);
});
