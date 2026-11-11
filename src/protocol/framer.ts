/**
 * Strict LF JSONL framer.
 *
 * Pi RPC records are delimited only by `\n` (optional preceding `\r`).
 * Node's readline also splits on U+2028 and U+2029, which are legal inside
 * JSON strings, so this framer never treats those as record boundaries.
 * Incomplete UTF-8 sequences stay buffered until a full line is available.
 */
export class LineFramer {
    private buffer: Buffer = Buffer.alloc(0);

    push(chunk: Buffer | Uint8Array | string): string[] {
        const next = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
        this.buffer = this.buffer.length === 0 ? Buffer.from(next) : Buffer.concat([this.buffer, next]);
        const lines: string[] = [];
        let start = 0;
        for (let i = 0; i < this.buffer.length; i++) {
            if (this.buffer[i] !== 0x0a) {
                continue;
            }
            let end = i;
            if (end > start && this.buffer[end - 1] === 0x0d) {
                end--;
            }
            lines.push(this.buffer.subarray(start, end).toString('utf8'));
            start = i + 1;
        }
        this.buffer = this.buffer.subarray(start);
        return lines;
    }

    /** Bytes still waiting for a newline. Exposed for tests. */
    remainder(): Buffer {
        return Buffer.from(this.buffer);
    }

    reset(): void {
        this.buffer = Buffer.alloc(0);
    }
}
