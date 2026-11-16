import { createHmac, timingSafeEqual } from 'node:crypto';

function canonical(ctx: Record<string, unknown>): string {
    const keys = Object.keys(ctx).filter((k) => k !== 'sig').sort();
    return JSON.stringify(keys.map((k) => [k, ctx[k]]));
}

export function signContext(secret: string, ctx: Record<string, unknown>): Record<string, unknown> {
    const sig = createHmac('sha256', secret).update(canonical(ctx)).digest('hex');
    return { ...ctx, sig };
}

export function verifyContext(secret: string, ctx: Record<string, unknown>): boolean {
    if (typeof ctx['sig'] !== 'string') return false;
    const expected = createHmac('sha256', secret).update(canonical(ctx)).digest();
    let given: Buffer;
    try {
        given = Buffer.from(ctx['sig'], 'hex');
    } catch {
        return false;
    }
    return given.length === expected.length && timingSafeEqual(given, expected);
}

export function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

/** Stable key appended to the button-callback URL so only Mattermost (which hides integration URLs from clients) can call it. */
export function endpointKey(secret: string, purpose: string): string {
    return createHmac('sha256', secret).update(`endpoint:${purpose}`).digest('hex').slice(0, 32);
}
