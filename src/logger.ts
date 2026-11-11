export interface Logger {
    info(message: string): void;
    debug(message: string): void;
}

export const noopLogger: Logger = {
    info() {
        /* empty */
    },
    debug() {
        /* empty */
    },
};
