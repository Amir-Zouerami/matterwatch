import type { App } from '../app.ts';
import { log, errMsg } from '../logger.ts';
import { link, table, code } from '../render/table.ts';
import { pipelineStyle } from '../render/theme.ts';
import { truncate } from '../util/text.ts';
import { localParts, relativeTime } from '../util/time.ts';
import { linkedUser, sendDm } from './people.ts';
import type { GlMr } from '../gitlab/client.ts';

function mrRow(m: GlMr): string[] {
    return [
        link(`!${m.iid}`, m.web_url),
        truncate(m.title, 55),
        m.author.username,
        (m.reviewers ?? []).map((r) => r.username).join(', ') || '—',
        m.head_pipeline ? `${pipelineStyle(m.head_pipeline.status).emoji}` : '—',
        relativeTime(new Date(m.updated_at)),
    ];
}

const HEAD = ['MR', 'Title', 'Author', 'Reviewers', 'CI', 'Updated'];

export async function runDigest(app: App, opts: { force?: boolean } = {}): Promise<void> {
    const now = new Date();
    const p = localParts(now, app.cfg.TZ_NAME);
    const channelId = app.cfg.MM_UPDATES_CHANNEL_ID;

    if (app.features.isEnabled('digest.daily', { channelId }) && (opts.force || (p.hour === app.cfg.DIGEST_HOUR && app.once.claim(`digest:daily:${p.day}`)))) {
        const open = await app.gl.listMrs({ state: 'opened', perPage: 100 });
        const failing = open.filter((m) => m.head_pipeline?.status === 'failed');
        const noReview = open.filter((m) => !m.draft && (m.reviewers ?? []).length === 0);
        const parts = [
            `#### ☀️ Daily digest — ${open.length} open merge request${open.length === 1 ? '' : 's'}`,
            open.length ? table(HEAD, open.slice(0, 25).map(mrRow)) : '_Nothing open. Enjoy the quiet._',
            failing.length ? `**❌ Failing pipelines (${failing.length})**\n${table(HEAD, failing.slice(0, 10).map(mrRow))}` : '',
            noReview.length ? `**👀 No reviewer assigned (${noReview.length})**: ${noReview.slice(0, 10).map((m) => link(`!${m.iid}`, m.web_url)).join(', ')}` : '',
        ].filter(Boolean);
        await app.mm.createPost({ channel_id: channelId, message: parts.join('\n\n') });
    }

    if (app.features.isEnabled('digest.stale_mr', { channelId }) && (opts.force || (p.hour === app.cfg.DIGEST_HOUR && app.once.claim(`digest:stale-run:${p.day}`)))) {
        const cutoff = Date.now() - app.cfg.STALE_MR_HOURS * 3_600_000;
        const open = await app.gl.listMrs({ state: 'opened', perPage: 100 });
        const byReviewer = new Map<string, GlMr[]>();
        for (const m of open) {
            if (m.draft || new Date(m.updated_at).getTime() > cutoff) continue;
            for (const r of m.reviewers ?? []) {
                if (!opts.force && !app.once.claim(`stale:${p.day}:${m.id}:${r.username}`)) continue;
                byReviewer.set(r.username, [...(byReviewer.get(r.username) ?? []), m]);
            }
        }
        for (const [username, list] of byReviewer) {
            const u = await linkedUser(app, { username });
            if (!u) continue;
            await sendDm(app, u, 'digest', { message: `⏰ **${list.length} merge request${list.length === 1 ? '' : 's'} waiting for your review**\n${table(['MR', 'Title', 'Author', 'Waiting'], list.slice(0, 10).map((m) => [link(`!${m.iid}`, m.web_url), truncate(m.title, 60), m.author.username, relativeTime(new Date(m.updated_at))]))}` }).catch((e) => log.warn('stale dm failed', { err: errMsg(e) }));
        }
    }

    // Saturday is the first working day in Iran.
    if (app.features.isEnabled('digest.weekly', { channelId }) && (opts.force ? false : p.weekday === 6 && p.hour === app.cfg.DIGEST_HOUR && app.once.claim(`digest:weekly:${p.day}`))) {
        const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
        const merged = await app.gl.listMrs({ state: 'merged', perPage: 100, updatedAfter: since });
        const byAuthor = new Map<string, number>();
        for (const m of merged) byAuthor.set(m.author.username, (byAuthor.get(m.author.username) ?? 0) + 1);
        const rows = [...byAuthor.entries()].sort((a, b) => b[1] - a[1]).map(([a, n]) => [a, String(n)]);
        await app.mm.createPost({ channel_id: channelId, message: `#### 📊 Last 7 days — ${merged.length} merged\n${rows.length ? table(['Author', 'Merged'], rows) : '_No merges._'}\n${code('digest.weekly')} can be switched off with \`/gl features off digest.weekly\`.` });
    }
}
