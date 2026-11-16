const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

let threshold: number = levels.info;

export function setLogLevel(level: Level): void {
    threshold = levels[level];
}

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
    if (levels[level] < threshold) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
    debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
};

export function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
