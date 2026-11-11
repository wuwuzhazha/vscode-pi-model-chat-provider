import { createHash } from 'node:crypto';

export function sha256(data: string | Uint8Array): string {
    const hash = createHash('sha256');
    if (typeof data === 'string') {
        hash.update(data);
    } else {
        hash.update(data);
    }
    return hash.digest('hex');
}
