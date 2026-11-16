import type { App } from '../app.ts';
import { nowIso, tx } from '../db/index.ts';
import { log, errMsg } from '../logger.ts';
import { backoffMs } from '../util/async.ts';
import type { OutPost } from '../mattermost/types.ts';
import { postFailureLogs } from './failure-logs.ts';
import { isPermanent } from '../util/errors.ts';
import { markDmBlocked } from './people.ts';

/**
 * The outbox. Every side effect that must not be lost or repeated (DMs, thread pings, failure logs) is written
 * here first, then delivered by `runDueScheduled` with retries. `dedupeKey` makes the enqueue idempotent, so a
 * retried inbox event can never produce a second copy.
 * Returns false when the key already existed.
 */
export function enqueueScheduled(app: App, kind: string, payload: unknown, runAt: Date, dedupeKey: string | null = null): boolean {
    const info = app.db
        .prepare('INSERT OR IGNORE INTO scheduled (kind, payload, run_at, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?)')
        .run(kind, JSON.stringify(payload), runAt.toISOString(), nowIso(), dedupeKey);
    return Number(info.changes) === 1;
}

interface Row {
    id: number;
    kind: string;
    payload: string;
    attempts: number;
}

type Payload = {
    mmUserId?: string;
    channelId?: string;
    post?: Omit<OutPost, 'channel_id'>;
    projectId?: number;
    pipelineId?: number;
    rootId?: string | null;
};

export const OUTBOX_MAX_ATTEMPTS = 12;

/** Deliver due outbox rows. Safe to call concurrently: rows are leased inside a transaction. */
export async function runDueScheduled(app: App, limit = 50): Promise<number> {
    const due = tx(app.db, () => {
        const rows = app.db
            .prepare(`SELECT id, kind, payload, attempts FROM scheduled WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT ?`)
            .all(nowIso(), limit) as unknown as Row[];
        // Lease: if we crash mid-delivery the row becomes due again after a minute.
        const claim = app.db.prepare('UPDATE scheduled SET run_at = ? WHERE id = ?');
        const lease = new Date(Date.now() + 60_000).toISOString();
        for (const r of rows) claim.run(lease, r.id);
        return rows;
    });
    let done = 0;
    for (const row of due) {
        try {
            const p = JSON.parse(row.payload) as Payload;
            if (row.kind === 'dm' && p.mmUserId && p.post) {
                const ch = await app.mm.dmChannel(p.mmUserId);
                await app.mm.createPost({ ...p.post, channel_id: ch });
            } else if (row.kind === 'post' && p.channelId && p.post) {
                await app.mm.createPost({ ...p.post, channel_id: p.channelId });
            } else if (row.kind === 'failure_logs' && p.channelId && p.projectId && p.pipelineId) {
                await postFailureLogs(app, { projectId: p.projectId, pipelineId: p.pipelineId, channelId: p.channelId, rootId: p.rootId ?? null });
            }
            app.db.prepare(`UPDATE scheduled SET status = 'done', error = NULL WHERE id = ?`).run(row.id);
            done++;
        } catch (e) {
            const attempts = row.attempts + 1;
            // Refused for good (user blocked/deactivated the bot, channel gone, …): never retry, and stop DMing that person for a while.
            const permanent = isPermanent(e);
            const dead = permanent || attempts >= OUTBOX_MAX_ATTEMPTS;
            if (permanent && row.kind === 'dm') {
                const uid = (JSON.parse(row.payload) as Payload).mmUserId;
                if (uid) markDmBlocked(app, uid);
            }
            app.db
                .prepare('UPDATE scheduled SET attempts = ?, error = ?, status = ?, run_at = ? WHERE id = ?')
                .run(attempts, errMsg(e), dead ? 'dead' : 'pending', new Date(Date.now() + backoffMs(attempts, 3000)).toISOString(), row.id);
            log[permanent ? 'info' : 'warn'](permanent ? 'outbox delivery refused, not retrying' : 'outbox delivery failed', { id: row.id, kind: row.kind, attempts, dead, err: errMsg(e) });
        }
    }
    return done;
}

/** Deliver whatever is due right now (called after each event so DMs/logs are not delayed by the timer). */
export async function flushOutbox(app: App): Promise<void> {
    await runDueScheduled(app).catch((e) => log.error('outbox flush failed', { err: errMsg(e) }));
}

export function purgeOldRows(app: App): void {
    const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
    app.db.prepare(`DELETE FROM scheduled WHERE status != 'pending' AND created_at < ?`).run(cutoff);
    app.db.prepare(`DELETE FROM inbound_events WHERE status != 'pending' AND received_at < ?`).run(cutoff);
    app.db.prepare(`DELETE FROM audit_log WHERE ts < ?`).run(new Date(Date.now() - 90 * 86_400_000).toISOString());
    app.cards.prune(60);
    app.watches.expireOld();
}

/** Put dead rows back in the queue (after an outage was fixed). */
export function requeueDead(app: App): { inbound: number; outbox: number } {
    const at = nowIso();
    const inbound = Number(app.db.prepare(`UPDATE inbound_events SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE status = 'dead'`).run(at).changes);
    const outbox = Number(app.db.prepare(`UPDATE scheduled SET status = 'pending', attempts = 0, run_at = ? WHERE status = 'dead'`).run(at).changes);
    return { inbound, outbox };
}
