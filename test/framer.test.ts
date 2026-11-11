import assert from 'node:assert/strict';
import test from 'node:test';
import { LineFramer } from '../src/protocol/framer.js';

test('framer keeps unicode line separators inside a JSON string', () => {
    const payload = JSON.stringify({ text: 'A\u2028B\u2029C\nD' }) + '\n';
    const framer = new LineFramer();
    const bytes = Buffer.from(payload, 'utf8');
    const lines: string[] = [];
    for (const byte of bytes) {
        lines.push(...framer.push(Buffer.from([byte])));
    }
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).text, 'A\u2028B\u2029C\nD');
    assert.equal(framer.remainder().length, 0);
});

test('framer splits only on LF and accepts CRLF', () => {
    const framer = new LineFramer();
    const first = framer.push(Buffer.from('{"a":1}\r\n{"b":'));
    const second = framer.push(Buffer.from('2}\n'));
    assert.deepEqual(first, ['{"a":1}']);
    assert.deepEqual(second, ['{"b":2}']);
});

test('framer reassembles a multibyte character split across chunks', () => {
    const framer = new LineFramer();
    const line = Buffer.from('{"t":"你"}\n', 'utf8');
    const split = line.indexOf(Buffer.from('你', 'utf8')[1]);
    const lines = [
        ...framer.push(line.subarray(0, split)),
        ...framer.push(line.subarray(split)),
    ];
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).t, '你');
});
