import { createHash } from 'node:crypto';
import type { App } from '../app.ts';
import { nowIso, tx } from '../db/index.ts';
import { parseEvent } from '../gitlab/events.ts';
import { log, errMsg } from '../logger.ts';
import { backoffMs } from '../util/async.ts';
import { runWithSeq } from '../util/context.ts';
import { isPermanent } from '../util/errors.ts';
import { dispatchEvent } from './handlers.ts';

export interface Accepted {
    accepted: boolean;
    duplicate: boolean;
    reason?: string;
}

/** Persist the delivery first (so a crash or Mattermost outage never loses it), then ack. */
export function acceptWebhook(app: App, headers: { uuid?: string | undefined; idempotency?: string | undefined; eventHeader?: string | undefined }, rawBody: string): Accepted {
    let payload: unknown;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return { accepted: false, duplicate: false, reason: 'invalid json' };
    }
    const kind = (payload as { object_kind?: string } | null)?.object_kind ?? headers.eventHeader ?? 'unknown';
    const key = headers.idempotency || headers.uuid || createHash('sha256').update(rawBody).digest('hex');
    const project = (payload as { project?: { path_with_namespace?: string } } | null)?.project?.path_with_namespace ?? null;
    const info = app.db
        .prepare(`INSERT OR IGNORE INTO inbound_events (delivery_key, event_type, project_path, payload, next_attempt_at, received_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(key, kind, project, rawBody, nowIso(), nowIso());
    return { accepted: true, duplicate: info.changes === 0 };
}

/** ~4.5 h of retries (backoff caps at 15 min) before an event is parked as `dead` (revive with /admin/requeue). */
export const INBOX_MAX_ATTEMPTS = 20;

let draining = false;

/** Process pending deliveries one at a time, in arrival order. */
export async function drainInbound(app: App, limit = 50): Promise<number> {
    if (draining) return 0;
    draining = true;
    let processed = 0;
    try {
        const rows = app.db
            .prepare(`SELECT id, payload, attempts FROM inbound_events WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?`)
            .all(nowIso(), limit) as unknown as { id: number; payload: string; attempts: number }[];
        for (const row of rows) {
            try {
                const parsed = parseEvent(JSON.parse(row.payload));
                if (!parsed.ok) {
                    app.db.prepare(`UPDATE inbound_events SET status = 'done', error = ?, processed_at = ? WHERE id = ?`).run(`ignored: ${parsed.reason}`, nowIso(), row.id);
                    continue;
                }
                // The inbox id is the event's identity: it keys outbox dedupe and the stale-card guard.
                await runWithSeq(row.id, () => dispatchEvent(app, parsed.event));
                app.db.prepare(`UPDATE inbound_events SET status = 'done', error = NULL, processed_at = ? WHERE id = ?`).run(nowIso(), row.id);
                processed++;
            } catch (e) {
                const attempts = row.attempts + 1;
                // A refusal that will not fix itself (403/404…) gets 3 tries, not 20 hours of them.
                const dead = attempts >= (isPermanent(e) ? 3 : INBOX_MAX_ATTEMPTS);
                tx(app.db, () =>
                    app.db
                        .prepare(`UPDATE inbound_events SET attempts = ?, error = ?, status = ?, next_attempt_at = ? WHERE id = ?`)
                        .run(attempts, errMsg(e), dead ? 'dead' : 'pending', new Date(Date.now() + backoffMs(attempts, 5000)).toISOString(), row.id),
                );
                log.error('event processing failed', { id: row.id, attempts, dead, err: errMsg(e) });
            }
        }
    } finally {
        draining = false;
    }
    return processed;
}
