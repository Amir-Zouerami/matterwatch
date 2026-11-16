import type { App } from '../app.ts';
import type { PipelineEvent } from '../gitlab/events.ts';
import { isTerminalPipeline } from '../gitlab/events.ts';
import type { GlPipeline, GlJob } from '../gitlab/client.ts';
import { log, errMsg } from '../logger.ts';
import type { MmPost } from '../mattermost/types.ts';
import { renderPipelineCard, renderSimpleCard, type JobView, type PipelineView } from '../render/cards.ts';
import { pipelineStyle } from '../render/theme.ts';
import { code, link } from '../render/table.ts';
import type { Watch } from '../domain/stores.ts';
import { extractGitlabRefs, type GitlabRef } from '../util/urls.ts';
import { parseGitlabDate } from '../util/time.ts';
import { truncate } from '../util/text.ts';
import { withLock } from '../util/lock.ts';
import { personView, type GlPerson } from './people.ts';
import { enqueueScheduled, flushOutbox } from './scheduler.ts';
import { fetchMr, pipelineButtons, pipelineViewFromEvent, renderOpts, routeChannel, upsertCard } from './handlers.ts';

const RESULT_EMOJI: Record<string, string> = { success: 'white_check_mark', failed: 'x', canceled: 'no_entry_sign', skipped: 'fast_forward' };

const projectUrlOf = (app: App, path: string): string => `${app.cfg.GITLAB_URL}/${path}`;

// ───────────────────────── link detection ─────────────────────────

/** Called for every post the bot can see on the websocket. */
export async function handleMessagePosted(app: App, post: MmPost): Promise<void> {
    if (post.user_id === app.bot.id) return;
    if (post.type && post.type.startsWith('system_')) return;
    if (post.props && (post.props['from_webhook'] === 'true' || post.props['from_bot'] === 'true')) return;
    if (!post.message.includes(app.cfg.GITLAB_URL.replace(/^https?:\/\//, ''))) return;
    const refs = extractGitlabRefs(post.message, app.cfg.GITLAB_URL).filter((r) => r.kind !== 'job').slice(0, 3);
    for (const ref of refs) {
        try {
            await watchRef(app, ref, { channelId: post.channel_id, rootPostId: post.root_id || post.id, postId: post.id, userId: post.user_id });
        } catch (e) {
            log.warn('link watch failed', { url: ref.url, err: errMsg(e) });
        }
    }
    await flushOutbox(app);
}

export async function watchRef(app: App, ref: GitlabRef, ctx: { channelId: string; rootPostId: string | null; postId: string | null; userId: string | null; force?: boolean }): Promise<{ status: 'created' | 'exists' | 'skipped'; reason?: string; watch?: Watch }> {
    if (ref.kind === 'job') return { status: 'skipped', reason: 'job links are not watchable' };
    const feature = ref.kind === 'mr' ? 'links.watch_mr' : 'links.watch_pipeline';
    if (!app.features.isEnabled(feature, { channelId: ctx.channelId })) return { status: 'skipped', reason: 'feature disabled' };

    const project = await app.gl.getProject(ref.projectPath);
    app.projects.touch(project.id, project.path_with_namespace);
    if (!ctx.force && routeChannel(app, project.id) === ctx.channelId) return { status: 'skipped', reason: 'this channel already receives all updates for the project' };

    const react = async (emoji: string): Promise<void> => {
        if (ctx.postId && app.features.isEnabled('links.react', { channelId: ctx.channelId })) await app.mm.addReaction(ctx.postId, emoji).catch(() => undefined);
    };

    if (ref.kind === 'mr') {
        const mr = await app.gl.getMr(project.id, ref.iid);
        if (mr.state !== 'opened') {
            await react(mr.state === 'merged' ? 'large_purple_circle' : 'x');
            return { status: 'skipped', reason: `MR is ${mr.state}` };
        }
        const { watch, created } = app.watches.create({ projectId: project.id, projectPath: project.path_with_namespace, kind: 'mr', ref: mr.iid, channelId: ctx.channelId, rootPostId: ctx.rootPostId, requestedBy: ctx.userId });
        await react('eyes');
        if (!created) return { status: 'exists', watch };
        const pipeline = mr.head_pipeline ?? (await app.gl.listMrPipelines(project.id, mr.iid).then((l) => l[0] ?? null).catch(() => null));
        if (pipeline) await syncWatchApi(app, watch, pipeline);
        else await postWaitingCard(app, watch, `Watching ${link(`!${mr.iid}`, mr.web_url)} ${truncate(mr.title, 80)} — no pipeline yet. I'll report here when it finishes.`);
        return { status: 'created', watch };
    }

    const pipeline = await app.gl.getPipeline(project.id, ref.id);
    const { watch, created } = app.watches.create({ projectId: project.id, projectPath: project.path_with_namespace, kind: 'pipeline', ref: ref.id, channelId: ctx.channelId, rootPostId: ctx.rootPostId, requestedBy: ctx.userId });
    await react('eyes');
    if (!created) return { status: 'exists', watch };
    await syncWatchApi(app, watch, pipeline);
    return { status: 'created', watch };
}

async function postWaitingCard(app: App, watch: Watch, text: string): Promise<void> {
    const post = renderSimpleCard({ emoji: '👀', headline: text, rows: [['Project', link(watch.project_path, projectUrlOf(app, watch.project_path))]], color: '#9ca3af' }, [], renderOpts(app, watch.channel_id));
    await upsertCard(app, { kind: 'watch', projectId: watch.project_id, ref: watch.id, channelId: watch.channel_id, post: { ...post, ...(watch.root_post_id ? { root_id: watch.root_post_id } : {}) }, state: 'waiting' });
}

// ───────────────────────── syncing ─────────────────────────

export async function viewFromApi(app: App, projectId: number, projectPath: string, p: GlPipeline, jobs: GlJob[], mr: { iid: number; title: string; url: string; state?: string } | null, mrAuthor?: GlPerson | null): Promise<PipelineView> {
    const projectUrl = projectUrlOf(app, projectPath);
    const actor = p.user ? await personView(app, { username: p.user.username, name: p.user.name }) : null;
    const jv: JobView[] = jobs.map((j) => ({ id: j.id, name: j.name, stage: j.stage, status: j.status, duration: j.duration ?? null, allowFailure: j.allow_failure, url: j.web_url }));
    return {
        projectPath, projectUrl, projectId, id: p.id, url: p.web_url, status: p.status, ref: p.ref, isTag: false, sha: p.sha,
        commitTitle: null, source: p.source ?? null, duration: p.duration ?? null, actor, author: (mrAuthor ? await personView(app, mrAuthor) : null) ?? actor, mr, jobs: jv, finishedAt: parseGitlabDate(p.finished_at),
    };
}

/** Webhook path: event already carries jobs, no API call needed for the card. */
export async function syncWatchesForPipeline(app: App, ev: PipelineEvent): Promise<void> {
    const o = ev.object_attributes;
    const found = new Map<number, Watch>();
    for (const w of app.watches.activeFor(ev.project.id, 'pipeline', o.id)) found.set(w.id, w);
    if (ev.merge_request) for (const w of app.watches.activeFor(ev.project.id, 'mr', ev.merge_request.iid)) if (!w.merge_sha) found.set(w.id, w);
    for (const w of app.watches.activeByMergeSha(ev.project.id, o.sha)) found.set(w.id, w);
    if (found.size === 0) return;
    const view = await pipelineViewFromEvent(app, ev);
    for (const w of found.values()) {
        if (w.kind === 'mr' && !view.mr) {
            const mr = await fetchMr(app, w.project_id, Number(w.ref));
            if (mr) view.mr = { iid: mr.iid, title: mr.title, url: mr.web_url, state: mr.state };
        }
        await syncWatch(app, w, { ...view });
    }
}

export async function syncWatchApi(app: App, watch: Watch, pipeline: GlPipeline): Promise<void> {
    const key = `${pipeline.id}:${pipeline.status}`;
    const card = app.cards.get('watch', watch.project_id, watch.id, watch.channel_id);
    if (card?.state === key) return;
    const jobs = await app.gl.listPipelineJobs(watch.project_id, pipeline.id).catch(() => []);
    let mr: { iid: number; title: string; url: string; state?: string } | null = null;
    let mrAuthor: GlPerson | null = null;
    if (watch.kind === 'mr') {
        const m = await fetchMr(app, watch.project_id, Number(watch.ref));
        if (m) {
            mr = { iid: m.iid, title: m.title, url: m.web_url, state: m.state };
            mrAuthor = { username: m.author.username, name: m.author.name };
        }
    }
    await syncWatch(app, watch, await viewFromApi(app, watch.project_id, watch.project_path, pipeline, jobs, mr, mrAuthor));
}

export async function syncWatch(app: App, watch: Watch, view: PipelineView): Promise<void> {
    await syncWatchLocked(app, watch, view);
    await flushOutbox(app);
}

async function syncWatchLocked(app: App, watch: Watch, view: PipelineView): Promise<void> {
    await withLock(`watch:${watch.id}`, async () => {
        const fresh = app.watches.get(watch.id);
        if (!fresh || fresh.status !== 'active') return;
        const key = `${view.id}:${view.status}`;
        const card = app.cards.get('watch', fresh.project_id, fresh.id, fresh.channel_id);
        if (card?.state === key) return;

        const f = { channelId: fresh.channel_id, projectId: fresh.project_id };
        const st = pipelineStyle(view.status);
        if (fresh.merge_sha && view.mr) view.mr = { ...view.mr, state: 'merged' }; // a cached MR lookup may still say "opened"
        const post = renderPipelineCard(view, renderOpts(app, fresh.channel_id), pipelineButtons(app, { projectId: view.projectId, projectPath: view.projectPath, id: view.id, status: view.status, channelId: fresh.channel_id, mrIid: view.mr?.iid ?? null, mrState: view.mr?.state ?? null }), false);
        const label = view.mr ? `MR ${link(`!${view.mr.iid}`, view.mr.url)}` : `pipeline ${link(`#${view.id}`, view.url)}`;
        post.message = isTerminalPipeline(view.status) ? `${st.emoji} **Pipeline ${link(`#${view.id}`, view.url)} ${st.label}** · ${label}` : `👀 Watching ${label} — pipeline ${link(`#${view.id}`, view.url)} ${st.label}`;
        const postId = await upsertCard(app, { kind: 'watch', projectId: fresh.project_id, ref: fresh.id, channelId: fresh.channel_id, post: { ...post, ...(fresh.root_post_id ? { root_id: fresh.root_post_id } : {}) }, state: key });
        app.watches.update(fresh.id, { last_pipeline_id: view.id, ...(postId ? { card_post_id: postId } : {}), extendTtl: true });

        if (!isTerminalPipeline(view.status) || fresh.last_notified_pipeline === view.id) return;
        app.watches.update(fresh.id, { last_notified_pipeline: view.id });

        // Ping reply (edits never notify), result reaction, failure logs.
        const names: string[] = [];
        if (fresh.requested_by_mm && app.features.isEnabled('links.mention_poster', f)) {
            const u = await app.mm.userById(fresh.requested_by_mm).catch(() => null);
            if (u) names.push(`@${u.username}`);
        }
        if (view.author?.mention.startsWith('@') && !names.includes(view.author.mention)) names.push(view.author.mention);
        const verb = view.status === 'success' ? 'passed' : view.status;
        const stamp = view.finishedAt?.getTime() ?? view.status;
        enqueueScheduled(app, 'post', {
            channelId: fresh.channel_id,
            post: {
                message: `${st.emoji} ${names.join(' ')} pipeline ${link(`#${view.id}`, view.url)} for ${label} **${verb}**${view.duration ? ` in ${Math.round(view.duration / 60)} min` : ''}`.replace(/\s+/g, ' '),
                ...(fresh.root_post_id ? { root_id: fresh.root_post_id } : {}),
            },
        }, new Date(), `watchping:${fresh.id}:${view.id}:${stamp}`);
        if (fresh.root_post_id && app.features.isEnabled('links.react', f)) {
            // One current result on the message: drop 👀 and any earlier result (e.g. ✅ of the branch pipeline when
            // the merge pipeline then fails), keep 🟣 for "merged".
            await app.mm.removeReaction(fresh.root_post_id, 'eyes').catch(() => undefined);
            const emoji = RESULT_EMOJI[view.status];
            for (const e of Object.values(RESULT_EMOJI)) if (e !== emoji) await app.mm.removeReaction(fresh.root_post_id, e).catch(() => undefined);
            if (emoji) await app.mm.addReaction(fresh.root_post_id, emoji).catch(() => undefined);
        }
        if (view.status === 'failed') {
            enqueueScheduled(app, 'failure_logs', { projectId: fresh.project_id, pipelineId: view.id, channelId: fresh.channel_id, rootId: fresh.root_post_id }, new Date(), `logs:${fresh.channel_id}:${view.id}:${stamp}`);
        }
        if (fresh.kind === 'pipeline' || fresh.merge_sha) app.watches.update(fresh.id, { status: 'done' });
    });
}

// ───────────────────────── MR lifecycle ─────────────────────────

export async function onMrMerged(app: App, projectId: number, iid: number, mergeSha: string | null): Promise<void> {
    for (const w0 of app.watches.activeFor(projectId, 'mr', iid)) {
        let toSync: Watch | null = null;
        await withLock(`watch:${w0.id}`, async () => {
            // The merge webhook and the poller can both notice the merge; whoever gets the lock first claims it.
            const w = app.watches.get(w0.id);
            if (!w || w.status !== 'active' || w.merge_sha) return;
            const follow = app.features.isEnabled('pipeline.merge_follow', { channelId: w.channel_id, projectId });
            const sha = follow ? (mergeSha ?? (await app.gl.getMr(projectId, iid).then((m) => m.merge_commit_sha ?? m.squash_commit_sha ?? m.sha ?? null).catch(() => null))) : null;
            const mrLink = link(`!${iid}`, `${projectUrlOf(app, w.project_path)}/-/merge_requests/${iid}`);
            if (sha) {
                app.watches.update(w.id, { merge_sha: sha, extendTtl: true });
                toSync = { ...w, merge_sha: sha };
            } else {
                app.watches.update(w.id, { status: 'done' });
            }
            // Outbox + unique key: the note is delivered exactly once, even if two code paths race or an event is retried.
            enqueueScheduled(app, 'post', {
                channelId: w.channel_id,
                post: { message: sha ? `🟣 ${mrLink} was **merged** — following the pipeline on the target branch (${code(sha.slice(0, 8))}).` : `🟣 ${mrLink} was **merged**.`, ...(w.root_post_id ? { root_id: w.root_post_id } : {}) },
            }, new Date(), `merged-note:${w.id}`);
            if (w.root_post_id) await app.mm.addReaction(w.root_post_id, 'large_purple_circle').catch(() => undefined);
        });
        if (toSync) {
            const w = toSync as Watch;
            const existing = await app.gl.listPipelinesBySha(projectId, w.merge_sha!).catch(() => []);
            const pipeline = existing.find((p) => p.ref !== `refs/merge-requests/${iid}/head`) ?? existing[0];
            if (pipeline) await syncWatchApi(app, w, pipeline).catch(() => undefined);
        }
    }
    await flushOutbox(app);
}

export async function onMrClosed(app: App, projectId: number, iid: number): Promise<void> {
    for (const w of app.watches.activeFor(projectId, 'mr', iid)) {
        await app.mm.createPost({ channel_id: w.channel_id, message: `🔴 ${link(`!${iid}`, `${projectUrlOf(app, w.project_path)}/-/merge_requests/${iid}`)} was **closed** — no longer watching.`, ...(w.root_post_id ? { root_id: w.root_post_id } : {}) }).catch(() => undefined);
        app.watches.stop(w.id);
    }
}

// ───────────────────────── polling fallback ─────────────────────────

export async function pollWatches(app: App): Promise<void> {
    app.watches.expireOld();
    if (!app.features.isEnabled('pipeline.poller')) return;
    for (const w of app.watches.allActive()) {
        try {
            if (w.merge_sha) {
                const list = await app.gl.listPipelinesBySha(w.project_id, w.merge_sha);
                const p = list[0];
                if (p) await syncWatchApi(app, w, p);
            } else if (w.kind === 'mr') {
                const mr = await app.gl.getMr(w.project_id, Number(w.ref));
                if (mr.state === 'merged') await onMrMerged(app, w.project_id, mr.iid, mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha ?? null);
                else if (mr.state === 'closed') await onMrClosed(app, w.project_id, mr.iid);
                else if (mr.head_pipeline) await syncWatchApi(app, w, mr.head_pipeline);
            } else {
                await syncWatchApi(app, w, await app.gl.getPipeline(w.project_id, Number(w.ref)));
            }
        } catch (e) {
            log.warn('poll failed for watch', { watch: w.id, err: errMsg(e) });
        }
    }
}
