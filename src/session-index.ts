import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256 } from './hash.js';
import { isPathInside } from './workspace-policy.js';

interface IndexFile {
    version: 1;
    sessions: Record<string, { sessionFile: string }>;
}

/**
 * Maps a transcript hash to a Pi session JSONL path.
 * The file lives inside the workspace session directory (opt-in only).
 */
export class SessionIndex {
    private readonly filePath: string;

    constructor(private readonly sessionDir: string) {
        this.filePath = path.join(sessionDir, 'provider-index.json');
    }

    get(canonical: string): string | undefined {
        const data = this.read();
        const hit = data.sessions[sha256(canonical)];
        if (!hit) {
            return undefined;
        }
        if (!isPathInside(this.sessionDir, hit.sessionFile)) {
            return undefined;
        }
        if (!fs.existsSync(hit.sessionFile)) {
            return undefined;
        }
        return hit.sessionFile;
    }

    set(canonical: string, sessionFile: string): void {
        if (!isPathInside(this.sessionDir, sessionFile)) {
            return;
        }
        const data = this.read();
        data.sessions[sha256(canonical)] = { sessionFile };
        fs.mkdirSync(this.sessionDir, { recursive: true });
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, this.filePath);
    }

    private read(): IndexFile {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<IndexFile>;
            if (parsed && parsed.version === 1 && parsed.sessions && typeof parsed.sessions === 'object') {
                return { version: 1, sessions: parsed.sessions };
            }
        } catch {
            /* missing or unreadable index starts empty */
        }
        return { version: 1, sessions: {} };
    }
}
