/**
 * ACTUAL Windows process test.
 * Skipped unless process.platform === 'win32'.
 * It copies this Node binary to node.exe, writes a standard npm pi.cmd and cli.js
 * under a path that contains spaces, and spawns them with shell: false.
 * Linux and macOS CI do not run the body.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { resolvePiLaunch } from '../src/pi-launch.js';
import { SHIM_READ_LIMIT } from '../src/pi-launch.js';

const onWindows = process.platform === 'win32';

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

const CLI_JS = `if (process.argv.includes('--version')) {
  process.stdout.write('1.5.2\\n');
  process.exit(0);
}
if (process.argv.includes('--wait')) {
  setInterval(() => {}, 1000);
}
process.stderr.write('unexpected args\\n');
process.exit(2);
`;

test('actual Windows: npm pi.cmd launches adjacent node.exe and cli.js without a shell', { skip: !onWindows }, async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'pi-win-'));
    const root = path.join(parent, 'Program Files');
    const script = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(root, 'node.exe'));
    fs.writeFileSync(path.join(root, 'pi.cmd'), CMD_SHIM);
    fs.writeFileSync(path.join(root, 'pi.ps1'), '# powershell shim fixture\n');
    fs.writeFileSync(path.join(root, 'pi'), '#!/bin/sh\n');
    fs.writeFileSync(script, CLI_JS);
    try {
        const resolved = resolvePiLaunch({
            binaryPath: 'pi',
            cwd: parent,
            env: { Path: root },
            platform: 'win32',
            io: {
                exists: (filePath) => fs.existsSync(filePath),
                read: (filePath) => {
                    const body = fs.readFileSync(filePath);
                    if (body.length > SHIM_READ_LIMIT) {
                        return { text: '', head: '', tooLarge: true };
                    }
                    return { text: body.toString('utf8'), head: body.subarray(0, 2).toString('latin1') };
                },
            },
        });
        assert.equal(resolved.ok, true);
        if (!resolved.ok) {
            return;
        }
        assert.equal(resolved.launch.command, path.join(root, 'node.exe'));
        assert.deepEqual(resolved.launch.prefixArgs, [script]);
        assert.equal(path.basename(resolved.launch.source).toLowerCase(), 'pi.cmd');

        const version = spawn(resolved.launch.command, [...resolved.launch.prefixArgs, '--version'], {
            shell: false,
            windowsHide: true,
        });
        let stdout = '';
        version.stdout.setEncoding('utf8');
        version.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        const [code] = await once(version, 'exit') as [number | null];
        assert.equal(code, 0);
        assert.equal(stdout.trim(), '1.5.2');

        const waiting = spawn(resolved.launch.command, [...resolved.launch.prefixArgs, '--wait'], {
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        await once(waiting, 'spawn');
        assert.equal(waiting.kill(), true);
        const [waitCode, waitSignal] = await once(waiting, 'exit') as [number | null, NodeJS.Signals | null];
        assert.ok(waitCode !== null || waitSignal !== null, 'killed node.exe did not exit');
        assert.equal(path.basename(resolved.launch.command).toLowerCase(), 'node.exe');
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});
