/** Serialises async work per key so two code paths never create the same card twice. */
const tails = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const next = prev.then(() => gate);
    tails.set(key, next);
    await prev.catch(() => undefined);
    try {
        return await fn();
    } finally {
        release();
        if (tails.get(key) === next) tails.delete(key);
    }
}
