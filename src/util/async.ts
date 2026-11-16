export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, capped. attempt is 1-based. */
export function backoffMs(attempt: number, baseMs = 2000, capMs = 15 * 60 * 1000): number {
    const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
    return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (i < items.length) {
                const idx = i++;
                out[idx] = await fn(items[idx]!);
            }
        }),
    );
    return out;
}
