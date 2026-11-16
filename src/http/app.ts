import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { App } from '../app.ts';
import { endpointKey, safeEqual } from '../mattermost/sign.ts';
import { log, errMsg } from '../logger.ts';
import { acceptWebhook } from '../services/ingest.ts';
import { requeueDead } from '../services/scheduler.ts';
import { handleAction } from '../services/actions.ts';
import { handleSlash } from '../services/slash.ts';
import { FEATURE_KEYS } from '../features/registry.ts';

export interface HttpDeps {
    kick: () => void;
    socketConnected: () => boolean;
}

const actionBody = z.object({
    user_id: z.string(),
    user_name: z.string().optional(),
    channel_id: z.string(),
    post_id: z.string(),
    context: z.record(z.string(), z.unknown()),
});

export function createHttpApp(app: App, deps: HttpDeps): Hono {
    const h = new Hono();

    h.get('/healthz', (c) => {
        try {
            app.db.prepare('SELECT 1').get();
            return c.json({ ok: true });
        } catch (e) {
            return c.json({ ok: false, error: errMsg(e) }, 503);
        }
    });

    h.get('/readyz', (c) => {
        const socketOk = !app.cfg.ENABLE_SOCKET || deps.socketConnected();
        return c.json({ ok: socketOk, websocket: deps.socketConnected() }, socketOk ? 200 : 503);
    });

    // GitLab → service
    h.post('/hooks/gitlab', bodyLimit({ maxSize: 5 * 1024 * 1024 }), async (c) => {
        const secret = app.cfg.GITLAB_WEBHOOK_SECRET;
        if (!secret) return c.json({ error: 'webhook secret not configured' }, 503);
        const token = c.req.header('x-gitlab-token') ?? '';
        if (!safeEqual(token, secret)) return c.json({ error: 'unauthorized' }, 401);
        const raw = await c.req.text();
        const res = acceptWebhook(
            app,
            { uuid: c.req.header('x-gitlab-event-uuid'), idempotency: c.req.header('idempotency-key'), eventHeader: c.req.header('x-gitlab-event') },
            raw,
        );
        if (!res.accepted) return c.json({ error: res.reason }, 400);
        deps.kick();
        return c.json({ ok: true, duplicate: res.duplicate }, 202);
    });

    // Mattermost → service: interactive buttons
    h.post('/mm/actions', bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
        if (!safeEqual(c.req.query('k') ?? '', endpointKey(app.cfg.ACTION_SIGNING_SECRET, 'actions'))) return c.json({ ephemeral_text: 'Unauthorized.' }, 401);
        const parsed = actionBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json({ ephemeral_text: 'Bad request.' }, 400);
        try {
            return c.json(await handleAction(app, parsed.data));
        } catch (e) {
            log.error('action crashed', { err: errMsg(e) });
            return c.json({ ephemeral_text: '❌ Something went wrong.' });
        }
    });

    // Mattermost → service: /gl
    h.post('/mm/slash', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
        const form = await c.req.parseBody();
        const token = String(form['token'] ?? '');
        const expected = app.slashToken();
        if (!expected || !safeEqual(token, expected)) return c.json({ error: 'unauthorized' }, 401);
        try {
            return c.json(await handleSlash(app, { user_id: String(form['user_id']), user_name: String(form['user_name'] ?? ''), channel_id: String(form['channel_id']), text: String(form['text'] ?? '') }));
        } catch (e) {
            log.error('slash crashed', { err: errMsg(e) });
            return c.json({ response_type: 'ephemeral', text: '❌ Something went wrong.' });
        }
    });

    // Admin / ops (disabled unless ADMIN_TOKEN is set)
    const admin = new Hono();
    admin.use('*', async (c, next) => {
        const t = app.cfg.ADMIN_TOKEN;
        const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
        if (!t || !safeEqual(given, t)) return c.json({ error: 'unauthorized' }, 401);
        await next();
    });
    admin.get('/features', (c) => c.json({ features: app.features.snapshot(), overrides: app.features.overrides() }));
    admin.put('/features/:key', async (c) => {
        const key = c.req.param('key');
        const body = z.object({ enabled: z.boolean(), scope: z.object({ type: z.enum(['channel', 'user', 'project']), id: z.string() }).optional() }).safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: 'bad body' }, 400);
        const keys = key.includes('*') || key === 'all' ? app.features.expand(key) : FEATURE_KEYS.has(key) ? [key] : [];
        if (keys.length === 0) return c.json({ error: 'unknown feature' }, 404);
        for (const k of keys) {
            if (body.data.scope) app.features.setOverride(k, body.data.scope.type, body.data.scope.id, body.data.enabled, 'admin-api');
            else app.features.setGlobal(k, body.data.enabled, 'admin-api');
        }
        return c.json({ ok: true, changed: keys });
    });
    admin.get('/status', (c) => c.json(status(app, deps)));
    admin.post('/requeue', (c) => {
        const r = requeueDead(app);
        deps.kick();
        return c.json({ ok: true, ...r });
    });
    admin.get('/audit', (c) => c.json(app.audit.recent(100)));
    h.route('/admin', admin);

    h.get('/metrics', (c) => {
        const t = app.cfg.METRICS_TOKEN;
        if (t && !safeEqual((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''), t)) return c.text('unauthorized', 401);
        const s = status(app, deps);
        const lines = [
            ...Object.entries(s.inbound).map(([k, v]) => `gitlab_mm_inbound_events{status="${k}"} ${v}`),
            ...Object.entries(s.scheduled).map(([k, v]) => `gitlab_mm_scheduled{status="${k}"} ${v}`),
            `gitlab_mm_active_watches ${s.activeWatches}`,
            `gitlab_mm_websocket_connected ${s.websocket ? 1 : 0}`,
            `gitlab_mm_uptime_seconds ${Math.round(process.uptime())}`,
        ];
        return c.text(lines.join('\n') + '\n');
    });

    h.notFound((c) => c.json({ error: 'not found' }, 404));
    h.onError((e, c) => {
        log.error('unhandled http error', { err: errMsg(e), path: c.req.path });
        return c.json({ error: 'internal error' }, 500);
    });
    return h;
}

function status(app: App, deps: HttpDeps) {
    const count = (table: string) =>
        Object.fromEntries((app.db.prepare(`SELECT status, COUNT(*) AS n FROM ${table} GROUP BY status`).all() as unknown as { status: string; n: number }[]).map((r) => [r.status, r.n]));
    return {
        inbound: count('inbound_events'),
        scheduled: count('scheduled'),
        activeWatches: (app.db.prepare(`SELECT COUNT(*) AS n FROM watches WHERE status = 'active'`).get() as { n: number }).n,
        websocket: deps.socketConnected(),
        bot: app.bot.username,
    };
}
