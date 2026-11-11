/**
 * Pi CLI versions this fork knows how to talk to.
 *
 * Thresholds come from the Pi changelog, not from the npm package bundled
 * with older builds of this extension:
 * - 0.74.0: RPC commands this provider already used, including
 *   get_last_assistant_text (the original extension's dependency floor).
 * - 0.80.4: RPC `agent_settled`. `agent_end` is only one low-level run and
 *   can be followed by retries, compaction, or queued follow-ups.
 * - 0.84.4: RPC `clear_queue`. `abort` alone keeps queued steering/follow-up.
 * - 1.5.0: prompt responses include `data.disposition`.
 */

export interface SemVer {
    major: number;
    minor: number;
    patch: number;
    raw: string;
}

export interface PiCapabilities {
    version: SemVer;
    /** Wait for agent_settled instead of the first agent_end. */
    agentSettled: boolean;
    /** Send clear_queue before abort. */
    clearQueue: boolean;
}

export const MIN_PI_VERSION = mustParse('0.74.0');
export const AGENT_SETTLED_VERSION = mustParse('0.80.4');
export const CLEAR_QUEUE_VERSION = mustParse('0.84.4');
export const PROMPT_DISPOSITION_VERSION = mustParse('1.5.0');

export function parseSemver(text: string): SemVer | undefined {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
    if (!match) {
        return undefined;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        raw: `${match[1]}.${match[2]}.${match[3]}`,
    };
}

export function compareSemver(left: SemVer, right: SemVer): number {
    if (left.major !== right.major) {
        return left.major - right.major;
    }
    if (left.minor !== right.minor) {
        return left.minor - right.minor;
    }
    return left.patch - right.patch;
}

export function capabilitiesFor(version: SemVer): PiCapabilities {
    return {
        version,
        agentSettled: compareSemver(version, AGENT_SETTLED_VERSION) >= 0,
        clearQueue: compareSemver(version, CLEAR_QUEUE_VERSION) >= 0,
    };
}

function mustParse(raw: string): SemVer {
    const parsed = parseSemver(raw);
    if (!parsed) {
        throw new Error(`Invalid version constant ${raw}`);
    }
    return parsed;
}
