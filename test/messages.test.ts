import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalTranscript, preparePrompt, type InboundMessage } from '../src/messages.js';
import { assistant, user } from './helpers.js';

test('current images are forwarded and other binaries are described', () => {
    const png = new Uint8Array([1, 2, 3, 4]);
    const audio = new Uint8Array([9, 9]);
    const prepared = preparePrompt([
        user('look', [
            { kind: 'image', mimeType: 'image/png', data: png },
            { kind: 'data', mimeType: 'audio/wav', data: audio },
        ]),
    ], 'continuation');
    assert.equal(prepared.images.length, 1);
    assert.equal(prepared.images[0].mimeType, 'image/png');
    assert.equal(prepared.images[0].data, Buffer.from(png).toString('base64'));
    assert.match(prepared.text, /audio\/wav \(2 bytes\)/);
    assert.match(prepared.limitations.join('\n'), /audio\/wav \(2 bytes\)/);
});

test('earlier images and host tool results are not dropped silently', () => {
    const messages: InboundMessage[] = [
        user('first', [{ kind: 'image', mimeType: 'image/jpeg', data: new Uint8Array([1]) }]),
        assistant('saw it'),
        {
            role: 'user',
            parts: [{
                kind: 'tool-result',
                toolCallId: 'call-1',
                resultParts: [
                    { kind: 'text', text: 'file contents' },
                    { kind: 'data', mimeType: 'application/pdf', data: new Uint8Array([4, 5]) },
                ],
            }],
        },
    ];
    const prepared = preparePrompt(messages, 'replay');
    assert.equal(prepared.images.length, 0);
    assert.match(prepared.text, /earlier image image\/jpeg/);
    assert.match(prepared.text, /file contents/);
    assert.match(prepared.text, /application\/pdf/);
    assert.match(prepared.limitations.join('\n'), /forwarded as text/);
    assert.match(prepared.text, /do not run it again/);
    assert.match(prepared.text, /restored this chat/);
});

test('continuation sends the new user text without the restore preamble', () => {
    const prepared = preparePrompt([
        assistant('previous answer'),
        user('do the next thing'),
    ], 'continuation');
    assert.equal(prepared.text.includes('restored this chat'), false);
    assert.match(prepared.text, /do the next thing/);
    assert.equal(prepared.text.includes('previous answer'), false);
});

test('canonical transcripts are prefix-stable', () => {
    const first = [user('one')];
    const second = [user('one'), assistant('two'), user('three')];
    const prefix = canonicalTranscript(first, 'anthropic:claude', '/work');
    const full = canonicalTranscript(second, 'anthropic:claude', '/work');
    assert.ok(full.startsWith(prefix));
    assert.notEqual(canonicalTranscript(first, 'openai:gpt', '/work'), prefix);
    assert.notEqual(canonicalTranscript(first, 'anthropic:claude', '/other'), prefix);
});
