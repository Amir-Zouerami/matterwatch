import type { App } from '../app.ts';
import { log, errMsg } from '../logger.ts';
import type { MmPost } from '../mattermost/types.ts';
import { handleMessagePosted } from './watch.ts';

const key = (channelId: string): string => `lastPost:${channelId}`;
const stamp = (p: MmPost): number => Math.max(p.update_at ?? 0, p.create_at ?? 0);

/** Remember how far we have read each watched channel (so a restart or websocket gap can be replayed). */
export function noteSeen(app: App, post: MmPost): void {
    if (!app.cfg.MM_WATCH_CHANNEL_IDS.includes(post.channel_id)) return;
    const t = stamp(post);
    if (t > app.settings.get<number>(key(post.channel_id), 0)) app.settings.set(key(post.channel_id), t);
}

/**
 * After every (re)connect: replay messages that arrived while we were not listening (deploys, restarts, network
 * blips). Link watching is idempotent, so replaying something we already handled is harmless.
 * First run for a channel only records "now": we never back-fill history.
 */
export async function catchUp(app: App): Promise<number> {
    let handled = 0;
    for (const channelId of app.cfg.MM_WATCH_CHANNEL_IDS) {
        try {
            const last = app.settings.get<number | null>(key(channelId), null);
            if (last === null) {
                app.settings.set(key(channelId), Date.now());
                continue;
            }
            const posts = await app.mm.postsSince(channelId, last);
            for (const p of posts) {
                if (stamp(p) <= last || p.delete_at) continue;
                await handleMessagePosted(app, p);
                noteSeen(app, p);
                handled++;
            }
        } catch (e) {
            log.warn('catch-up failed', { channelId, err: errMsg(e) });
        }
    }
    if (handled) log.info('replayed missed messages', { handled });
    return handled;
}
