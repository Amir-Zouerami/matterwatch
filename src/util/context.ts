import { AsyncLocalStorage } from 'node:async_hooks';

/** The inbox row currently being processed. Lets side effects derive stable, retry-safe keys. */
const als = new AsyncLocalStorage<{ seq: number }>();

export const runWithSeq = <T>(seq: number, fn: () => T): T => als.run({ seq }, fn);
export const currentSeq = (): number | null => als.getStore()?.seq ?? null;

/** Dedupe key unique per (inbox event, side effect); null outside event processing (no dedupe). */
export const eventKey = (suffix: string): string | null => {
    const s = currentSeq();
    return s === null ? null : `ev${s}:${suffix}`;
};
