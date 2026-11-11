import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const dir = path.join('out-test', 'test');
const files = readdirSync(dir)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join(dir, name));

if (files.length === 0) {
    console.error('No compiled tests in out-test/test');
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', '--test-timeout', '20000', ...files], {
    stdio: 'inherit',
});
process.exit(result.status === null ? 1 : result.status);
