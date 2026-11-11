/**
 * Errors surfaced to VS Code chat and the Pi Agent output channel.
 * Messages are written for a person reading the chat or the log.
 */

export class PiError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'PiError';
        this.code = code;
    }
}

export class PiTrustError extends PiError {
    constructor(message: string) {
        super('TRUST', message);
        this.name = 'PiTrustError';
    }
}

export class PiStartupError extends PiError {
    constructor(message: string) {
        super('STARTUP', message);
        this.name = 'PiStartupError';
    }
}

export class PiProtocolError extends PiError {
    constructor(message: string) {
        super('PROTOCOL', message);
        this.name = 'PiProtocolError';
    }
}

export class PiCancelledError extends PiError {
    constructor() {
        super('CANCELLED', 'Operation cancelled by user');
        this.name = 'PiCancelledError';
    }
}

export class PiHungError extends PiError {
    constructor(message: string) {
        super('HUNG', message);
        this.name = 'PiHungError';
    }
}

export class HostToolsError extends PiError {
    constructor(message: string) {
        super('HOST_TOOLS', message);
        this.name = 'HostToolsError';
    }
}
