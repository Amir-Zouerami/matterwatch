import type { App } from '../app.ts';
import type { GitlabEvent, MergeRequestEvent, NoteEvent, PipelineEvent, PushEvent, TagPushEvent, IssueEvent, DeploymentEvent, ReleaseEvent } from '../gitlab/events.ts';
import { isTerminalPipeline } from '../gitlab/events.ts';
import type { GlMr } from '../gitlab/client.ts';
import { log, errMsg } from '../logger.ts';
import type { OutPost } from '../mattermost/types.ts';
import {
    renderMrCard, renderPipelineCard, renderPushCard, renderSimpleCard,
    type ButtonSpec, type JobView, type MrView, type PersonView, type PipelineView, type RenderOpts,
} from '../render/cards.ts';
import { cleanMessageBody, defang, firstLine, shortSha, truncate } from '../util/text.ts';
import { parseGitlabDate } from '../util/time.ts';
import { currentSeq, eventKey } from '../util/context.ts';
import { enqueueScheduled, flushOutbox } from './scheduler.ts';
import { withLock } from '../util/lock.ts';
import { code, link } from '../render/table.ts';
import { linkedUser, peopleViews, personView, sendDm, type GlPerson } from './people.ts';
import { onMrClosed, onMrMerged, syncWatchesForPipeline } from './watch.ts';

export function renderOpts(app: App, channelId?: string): RenderOpts {
    return {
        tz: app.cfg.TZ_NAME,
        jalali: app.features.isEnabled('cards.jalali_dates', { channelId }),
        conventional: app.features.isEnabled('cards.conventional_commits', { channelId }),
        serviceUrl: app.cfg.SERVICE_URL,
        secret: app.cfg.ACTION_SIGNING_SECRET,
    };
}

export function routeChannel(app: App, projectId: number): string {
    const p = app.features.isEnabled('routing.per_project') ? app.projects.get(projectId) : null;
    return p?.channel_id ?? app.cfg.MM_UPDATES_CHANNEL_ID;
}

function isMuted(app: App, projectId: number): boolean {
    return app.features.isEnabled('routing.per_project') && app.projects.get(projectId)?.muted === 1;
}

function ignoredActor(app: App, username?: string | null): boolean {
    if (!username || !app.features.isEnabled('filters.ignore_bots')) return false;
    return app.cfg.IGNORE_USERS.some((u) => u.toLowerCase() === username.toLowerCase());
}

/**
 * Create the card, or edit the existing one in place. Returns the post id.
 * Stale guard: an inbox event older than the one that last wrote the card (a retried event overtaken by a newer
 * one) is dropped, so a card can never travel backwards (e.g. "passed" back to "running").
 */
export async function upsertCard(app: App, input: { kind: string; projectId: number; ref: string | number; channelId: string; post: Omit<OutPost, 'channel_id'>; state: string | null; createIfMissing?: boolean }): Promise<string | null> {
    return withLock(`card:${input.kind}:${input.projectId}:${input.ref}:${input.channelId}`, async () => {
        const seq = currentSeq() ?? 0;
        const inPlace = app.features.isEnabled('cards.update_in_place', { channelId: input.channelId, projectId: input.projectId });
        const existing = app.cards.get(input.kind, input.projectId, input.ref, input.channelId);
        if (existing && seq > 0 && existing.seq > seq) return existing.post_id;
        if (existing && inPlace) {
            try {
                await app.mm.patchPost(existing.post_id, { message: input.post.message, props: input.post.props ?? {} });
                app.cards.setState(existing.id, input.state ?? '', seq);
                return existing.post_id;
            } catch (e) {
                log.warn('card patch failed, posting a new one', { postId: existing.post_id, err: errMsg(e) });
            }
        }
        if (input.createIfMissing === false && !existing) return null;
        const created = await app.mm.createPost({ ...input.post, channel_id: input.channelId });
        app.cards.upsert(input.kind, input.projectId, input.ref, input.channelId, created.id, input.state, seq);
        return created.id;
    });
}

// ───────────────────────── merge requests ─────────────────────────

// Short-lived MR lookups (one per GitLab client, so nothing leaks between instances/tests).
const mrCaches = new WeakMap<object, Map<string, { at: number; mr: GlMr }>>();
export async function fetchMr(app: App, projectId: number, iid: number): Promise<GlMr | null> {
    let cache = mrCaches.get(app.gl);
    if (!cache) mrCaches.set(app.gl, (cache = new Map()));
    const key = `${projectId}:${iid}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 20_000) return hit.mr;
    try {
        const mr = await app.gl.getMr(projectId, iid);
        cache.set(key, { at: Date.now(), mr });
        if (cache.size > 200) cache.delete(cache.keys().next().value!);
        return mr;
    } catch (e) {
        log.debug('getMr failed', { err: errMsg(e) });
        return null;
    }
}

export function mrButtons(app: App, v: { projectId: number; projectPath: string; iid: number; state: string; channelId: string; pipelineId?: number | null }): ButtonSpec[] {
    if (v.state !== 'opened') return [];
    const ctx = { projectId: v.projectId, projectPath: v.projectPath, iid: v.iid };
    const f = { channelId: v.channelId, projectId: v.projectId };
    const out: ButtonSpec[] = [];
    if (app.features.isEnabled('actions.approve', f)) out.push({ id: 'approve_mr', name: '👍 Approve', style: 'primary', context: ctx });
    if (app.features.isEnabled('actions.merge', f)) out.push({ id: 'merge_mr', name: '🚀 Merge when green', style: 'success', context: ctx });
    return out;
}

export async function handleMergeRequest(app: App, ev: MergeRequestEvent): Promise<void> {
    const a = ev.object_attributes;
    const action = a.action ?? 'update';
    app.projects.touch(ev.project.id, ev.project.path_with_namespace);

    // Watches must react even when the project is muted or cards are off.
    // Link watches and the dedicated channel are independent: a failure on one side never blocks the other.
    try {
        if (action === 'merge') await onMrMerged(app, ev.project.id, a.iid, a.merge_commit_sha ?? a.last_commit?.id ?? null);
        if (action === 'close') await onMrClosed(app, ev.project.id, a.iid);
    } catch (e) {
        log.warn('watch handling failed for MR event (channel card unaffected)', { iid: a.iid, err: errMsg(e) });
    }

    const channelId = routeChannel(app, ev.project.id);
    if (isMuted(app, ev.project.id) || ignoredActor(app, ev.user.username)) return;
    const f = { channelId, projectId: ev.project.id };
    if (!app.features.isEnabled('cards.merge_request', f)) return;

    const changes = (ev.changes ?? {}) as Changes;
    const meaningfulUpdate = !!(a.oldrev || changes['reviewers'] || changes['assignees'] || changes['title'] || changes['draft'] || changes['target_branch'] || changes['labels'] || changes['state_id']);
    if (action === 'update' && !meaningfulUpdate) return;
    if (action === 'unapproved' || action === 'unapproval') return;

    // Channel policy: a NEW card only for opened / merged / review-requested MRs.
    // Everything else (approved, closed, new commits, label edits…) just keeps an existing card accurate.
    const requested = reviewRequests(ev, changes);
    const createsCard = action === 'open' || action === 'reopen' || action === 'merge' || requested.length > 0;
    if (!createsCard && !app.cards.get('mr', ev.project.id, a.iid, channelId)) return;

    const full = action === 'open' ? null : await fetchMr(app, ev.project.id, a.iid);
    const actor = await personView(app, ev.user);
    const commitEmail = a.last_commit?.author?.email;
    const author = full ? await personView(app, { username: full.author.username, name: full.author.name, emails: [commitEmail] }) : actor;
    const reviewers = await peopleViews(app, full?.reviewers ?? ev.reviewers);
    const assignees = await peopleViews(app, full?.assignees ?? ev.assignees);
    const headPipeline = full?.head_pipeline;

    const view: MrView = {
        projectPath: ev.project.path_with_namespace,
        projectUrl: ev.project.web_url ?? `${app.cfg.GITLAB_URL}/${ev.project.path_with_namespace}`,
        projectId: ev.project.id,
        iid: a.iid,
        title: a.title ?? full?.title ?? `!${a.iid}`,
        url: a.url ?? full?.web_url ?? '',
        state: a.state ?? full?.state ?? 'opened',
        draft: a.draft ?? full?.draft ?? false,
        source: a.source_branch ?? full?.source_branch ?? '?',
        target: a.target_branch ?? full?.target_branch ?? '?',
        action,
        actor,
        author,
        reviewers,
        assignees,
        labels: (ev.labels ?? []).map((l) => l.title),
        description: a.description,
        updatedAt: parseGitlabDate(a.updated_at),
        pipeline: headPipeline ? { id: headPipeline.id, status: headPipeline.status, url: headPipeline.web_url } : null,
        mergeStatus: a.detailed_merge_status ?? full?.detailed_merge_status ?? null,
    };

    const post = renderMrCard(view, renderOpts(app, channelId), mrButtons(app, { projectId: ev.project.id, projectPath: view.projectPath, iid: a.iid, state: view.state, channelId }), app.features.isEnabled('mentions.channel', f));
    const hadCard = !!app.cards.get('mr', ev.project.id, a.iid, channelId);
    const postId = await upsertCard(app, { kind: 'mr', projectId: ev.project.id, ref: a.iid, channelId, post, state: view.state, createIfMissing: createsCard });

    // Edits never notify, so a later review request gets its own short ping in the card's thread.
    if (postId && hadCard && requested.length && app.features.isEnabled('mentions.channel', f)) {
        const pings = (await peopleViews(app, requested)).map((p) => p.mention).filter((m) => m.startsWith('@'));
        if (pings.length) {
            enqueueScheduled(app, 'post', { channelId, post: { root_id: postId, message: `👀 ${pings.join(' ')} — review requested by ${actor?.mention ?? defang(ev.user.username ?? 'someone')}` } }, new Date(), eventKey(`ping:${postId}`));
        }
    }

    if (postId && app.features.isEnabled('cards.reactions', f)) {
        const emoji = action === 'merge' || view.state === 'merged' ? 'large_purple_circle' : action === 'close' || view.state === 'closed' ? 'x' : action === 'approved' || action === 'approval' ? 'white_check_mark' : null;
        if (emoji) await app.mm.addReaction(postId, emoji).catch(() => undefined);
    }

    await dmForMr(app, ev, view, changes);
}

type Changes = Record<string, { previous?: unknown; current?: unknown } | undefined>;
type GlUserLite = { username: string; name?: string; email?: string | null };

/** People newly added as reviewer/assignee by this event (everyone on `open`). */
export function reviewRequests(ev: MergeRequestEvent, changes: Changes): GlUserLite[] {
    const out = new Map<string, GlUserLite>();
    const collect = (key: 'reviewers' | 'assignees', current: GlUserLite[] | undefined): void => {
        const c = changes[key];
        if (c && Array.isArray(c.current)) {
            const prev = new Set((Array.isArray(c.previous) ? (c.previous as GlUserLite[]) : []).map((p) => p.username));
            for (const p of c.current as GlUserLite[]) if (!prev.has(p.username)) out.set(p.username, p);
        } else if (ev.object_attributes.action === 'open' || ev.object_attributes.action === 'reopen') {
            for (const p of current ?? []) out.set(p.username, p);
        }
    };
    collect('reviewers', ev.reviewers);
    collect('assignees', ev.assignees);
    out.delete(ev.user.username ?? '');
    return [...out.values()];
}

async function dmForMr(app: App, ev: MergeRequestEvent, view: MrView, changes: Changes): Promise<void> {
    const a = ev.object_attributes;
    const actorName = ev.user.username;
    const link_ = link(`!${a.iid} ${truncate(view.title, 80)}`, view.url);

    // Reviewer / assignee requests
    for (const p of reviewRequests(ev, changes)) {
        const u = await linkedUser(app, p);
        if (!u) continue;
        await sendDm(app, u, 'review', { message: `👀 **${actorName}** asked you to review ${link_}\n${code(view.source)} → ${code(view.target)} · ${link(view.projectPath, view.projectUrl)}` }, eventKey('dm:review')).catch((e) => log.warn('review dm failed', { err: errMsg(e) }));
    }

    // Author state updates
    const stateAction = a.action === 'approved' || a.action === 'approval' ? 'approved' : a.action === 'merge' ? 'merged' : a.action === 'close' ? 'closed' : null;
    if (stateAction && view.author?.gitlab && view.author.gitlab !== actorName) {
        const u = await linkedUser(app, { username: view.author.gitlab });
        const icon = stateAction === 'approved' ? '✅' : stateAction === 'merged' ? '🟣' : '🔴';
        if (u) await sendDm(app, u, 'state', { message: `${icon} Your merge request ${link_} was **${stateAction}** by ${actorName}.` }, eventKey('dm:state')).catch(() => undefined);
    }
}

/**
 * Re-render an announced, still-open MR card from fresh GitLab data so its pipeline line (and the merge button)
 * follow the latest pipeline instead of freezing at whatever it was when the MR event arrived.
 */
export async function refreshMrCard(app: App, input: { projectId: number; projectPath: string; projectUrl: string; iid: number; channelId: string; pipeline: { id: number; status: string; url: string } }): Promise<void> {
    const f = { channelId: input.channelId, projectId: input.projectId };
    if (!app.features.isEnabled('cards.mr_ci_status', f) || !app.features.isEnabled('cards.merge_request', f)) return;
    const card = app.cards.get('mr', input.projectId, input.iid, input.channelId);
    if (!card || card.state !== 'opened') return;
    const mr = await app.gl.getMr(input.projectId, input.iid).catch(() => null);
    if (!mr || mr.state !== 'opened') return;
    const view: MrView = {
        projectPath: input.projectPath,
        projectUrl: input.projectUrl,
        projectId: input.projectId,
        iid: mr.iid,
        title: mr.title,
        url: mr.web_url,
        state: mr.state,
        draft: mr.draft ?? false,
        source: mr.source_branch,
        target: mr.target_branch,
        action: null,
        actor: null,
        author: await personView(app, { username: mr.author.username, name: mr.author.name }),
        reviewers: await peopleViews(app, mr.reviewers),
        assignees: await peopleViews(app, mr.assignees),
        labels: mr.labels ?? [],
        updatedAt: parseGitlabDate(mr.updated_at),
        pipeline: input.pipeline,
        mergeStatus: mr.detailed_merge_status ?? null,
    };
    const post = renderMrCard(view, renderOpts(app, input.channelId), mrButtons(app, { projectId: input.projectId, projectPath: input.projectPath, iid: mr.iid, state: mr.state, channelId: input.channelId }), app.features.isEnabled('mentions.channel', f));
    await upsertCard(app, { kind: 'mr', projectId: input.projectId, ref: mr.iid, channelId: input.channelId, post, state: mr.state, createIfMissing: false });
}

// ───────────────────────── pipelines ─────────────────────────

export function pipelineButtons(app: App, v: { projectId: number; projectPath: string; id: number; status: string; channelId: string; mrIid?: number | null; mrState?: string | null; dm?: boolean }): ButtonSpec[] {
    // `dm` makes button replies land inline in the conversation (threads are invisible-ish in a 1:1 DM)
    const ctx: Record<string, unknown> = { projectId: v.projectId, projectPath: v.projectPath, pipelineId: v.id, ...(v.dm ? { dm: 1 } : {}) };
    const f = { channelId: v.channelId, projectId: v.projectId };
    const out: ButtonSpec[] = [];
    if (v.status === 'failed') {
        if (app.features.isEnabled('actions.retry', f)) out.push({ id: 'retry_pipeline', name: '🔁 Retry', style: 'primary', context: ctx });
        if (app.features.isEnabled('actions.logs', f)) out.push({ id: 'show_logs', name: '🔎 Show logs', context: ctx });
    } else if (v.status === 'canceled') {
        if (app.features.isEnabled('actions.retry', f)) out.push({ id: 'retry_pipeline', name: '🔁 Retry', style: 'primary', context: ctx });
    } else if (v.status === 'running' || v.status === 'pending') {
        if (app.features.isEnabled('actions.cancel', f)) out.push({ id: 'cancel_pipeline', name: '⏹ Cancel', style: 'danger', context: ctx });
    } else if (v.status === 'success' && v.mrIid && v.mrState === 'opened') {  // never offer "Merge" for an MR that is already merged/closed
        const mctx: Record<string, unknown> = { projectId: v.projectId, projectPath: v.projectPath, iid: v.mrIid, ...(v.dm ? { dm: 1 } : {}) };
        if (app.features.isEnabled('actions.merge', f)) out.push({ id: 'merge_mr', name: '🚀 Merge', style: 'success', context: mctx });
    }
    return out;
}

/**
 * Who wrote the code behind a pipeline (as opposed to who pressed the button):
 * MR pipelines → the MR author; merge commits on the target branch → the author of the merged MR;
 * plain commits → the commit author; last resort → whoever triggered it.
 */
export async function codeAuthor(app: App, ev: PipelineEvent): Promise<GlPerson | null> {
    const emails = [ev.commit?.author?.email];
    if (ev.merge_request) {
        const mr = await fetchMr(app, ev.project.id, ev.merge_request.iid);
        if (mr) return { username: mr.author.username, name: mr.author.name, emails };
    }
    const title = ev.commit?.title ?? firstLine(ev.commit?.message ?? '');
    if (/^Merge (branch|remote-tracking branch|pull request)\b/i.test(title)) {
        const mrs = await app.gl.listCommitMrs(ev.project.id, ev.object_attributes.sha).catch(() => []);
        const m = mrs.find((x) => x.state === 'merged') ?? mrs[0];
        if (m) return { username: m.author.username, name: m.author.name, emails };
    }
    const c = ev.commit?.author;
    if (c?.name || c?.email) {
        const sameAsTrigger = !!ev.user && ((!!c.email && c.email === ev.user.email) || (!!c.name && c.name === ev.user.name));
        if (!sameAsTrigger) return { name: c.name, emails: [c.email] };
    }
    return ev.user ?? null;
}

export async function pipelineViewFromEvent(app: App, ev: PipelineEvent): Promise<PipelineView> {
    const o = ev.object_attributes;
    const actor = await personView(app, ev.user ?? undefined);
    const author = (await personView(app, await codeAuthor(app, ev).catch(() => null))) ?? actor;
    const projectUrl = ev.project.web_url ?? `${app.cfg.GITLAB_URL}/${ev.project.path_with_namespace}`;
    const jobs: JobView[] = (ev.builds ?? [])
        .filter((b) => b.status !== 'created' || (ev.builds?.length ?? 0) < 25)
        .map((b) => ({ id: b.id, name: b.name, stage: b.stage ?? '-', status: b.status, duration: b.duration ?? null, allowFailure: b.allow_failure ?? false, url: `${projectUrl}/-/jobs/${b.id}` }));
    return {
        projectPath: ev.project.path_with_namespace,
        projectUrl,
        projectId: ev.project.id,
        id: o.id,
        url: `${projectUrl}/-/pipelines/${o.id}`,
        status: o.status,
        ref: o.ref,
        isTag: o.tag ?? false,
        sha: o.sha,
        commitTitle: ev.commit?.title ?? (ev.commit?.message ? firstLine(ev.commit.message) : null),
        source: o.source ?? null,
        duration: o.duration ?? null,
        actor,
        author,
        mr: ev.merge_request ? { iid: ev.merge_request.iid, title: ev.merge_request.title ?? '', url: ev.merge_request.url ?? `${projectUrl}/-/merge_requests/${ev.merge_request.iid}`, ...(ev.merge_request.state ? { state: ev.merge_request.state } : {}) } : null,
        jobs,
        finishedAt: parseGitlabDate(o.finished_at),
    };
}

export async function handlePipeline(app: App, ev: PipelineEvent): Promise<void> {
    const o = ev.object_attributes;
    app.projects.touch(ev.project.id, ev.project.path_with_namespace);

    // Link watches are explicit user requests: always process them.
    await syncWatchesForPipeline(app, ev).catch((e) => log.warn('watch sync failed', { err: errMsg(e) }));

    const channelId = routeChannel(app, ev.project.id);
    if (isMuted(app, ev.project.id) || ignoredActor(app, ev.user?.username)) return;
    const f = { channelId, projectId: ev.project.id };
    if (!app.features.isEnabled('cards.pipeline', f)) return;

    const terminal = isTerminalPipeline(o.status);
    const existing = app.cards.get('pipeline', ev.project.id, o.id, channelId);
    // "pipeline.running" gate: with cards.pipeline_running off the card appears at the first finished state.
    if (!existing && !terminal && !app.features.isEnabled('cards.pipeline_running', f)) return;

    const view = await pipelineViewFromEvent(app, ev);
    const mentions = app.features.isEnabled('mentions.channel', f);
    const post = renderPipelineCard(view, renderOpts(app, channelId), pipelineButtons(app, { projectId: view.projectId, projectPath: view.projectPath, id: view.id, status: view.status, channelId, mrIid: view.mr?.iid ?? null, mrState: view.mr?.state ?? null }), mentions);
    const postId = await upsertCard(app, { kind: 'pipeline', projectId: ev.project.id, ref: o.id, channelId, post, state: o.status });

    if (terminal && o.status === 'failed' && postId) {
        // Durable: the outbox retries GitLab/Mattermost hiccups; the key stops a replayed 'failed' event posting them twice.
        enqueueScheduled(app, 'failure_logs', { projectId: ev.project.id, pipelineId: o.id, channelId, rootId: postId }, new Date(), `logs:${channelId}:${o.id}:${o.finished_at ?? o.status}`);
    }

    if (ev.merge_request && postId) {
        await refreshMrCard(app, { projectId: ev.project.id, projectPath: view.projectPath, projectUrl: view.projectUrl, iid: ev.merge_request.iid, channelId, pipeline: { id: o.id, status: o.status, url: view.url } })
            .catch((e) => log.warn('MR card refresh failed', { err: errMsg(e) }));
    }

    if (terminal) await dmPipeline(app, ev, view);
}

async function dmPipeline(app: App, ev: PipelineEvent, view: PipelineView): Promise<void> {
    const o = ev.object_attributes;
    if (o.status !== 'failed' && o.status !== 'success') return;
    const author = await codeAuthor(app, ev).catch(() => null);
    // The person who wrote the code AND the one who triggered it (e.g. merged someone else's MR) both want the result.
    const people = new Map<string, Awaited<ReturnType<typeof linkedUser>>>();
    for (const p of [author, ev.user ?? undefined]) {
        const u = await linkedUser(app, p);
        if (u) people.set(u.mm_user_id, u);
    }
    for (const u of people.values()) {
        if (!u) continue;
        const failuresOnly = app.features.isEnabled('dm.pipeline_failures_only', { userId: u.mm_user_id }) || u.prefs.failuresOnly === true;
        if (failuresOnly && o.status !== 'failed') continue;
        const dedupe = `dm:pipe:${view.projectId}:${view.id}:${o.status}:${o.finished_at ?? ''}`;
        const icon = o.status === 'success' ? '✅' : '❌';
        const target = view.mr ? `${link(`!${view.mr.iid}`, view.mr.url)} ${truncate(view.mr.title, 70)}` : `${code(view.ref)}`;
        const failed = view.jobs.filter((j) => j.status === 'failed' && !j.allowFailure).map((j) => j.name);
        const verb = o.status === 'success' ? 'passed' : 'failed';
        const btns = pipelineButtons(app, { projectId: view.projectId, projectPath: view.projectPath, id: view.id, status: o.status, channelId: '', mrIid: view.mr?.iid ?? null, mrState: view.mr?.state ?? null, dm: true });
        if (btns.length) {
            const rendered = renderSimpleCard({ emoji: icon, headline: `Pipeline ${link(`#${view.id}`, view.url)} ${verb}`, rows: [['Where', target], ['Project', link(view.projectPath, view.projectUrl)], ['Failed jobs', failed.length ? failed.slice(0, 5).map(code).join(', ') : null]], color: o.status === 'success' ? '#2da44e' : '#dd2b0e' }, btns, renderOpts(app));
            await sendDm(app, u, 'pipeline', { message: rendered.message, props: rendered.props ?? {} }, dedupe);
        } else {
            await sendDm(app, u, 'pipeline', { message: `${icon} Pipeline ${link(`#${view.id}`, view.url)} **${verb}** — ${target}\n${link(view.projectPath, view.projectUrl)}${failed.length ? `\nFailed: ${failed.slice(0, 5).map(code).join(', ')}` : ''}` }, dedupe);
        }
    }
}

// ───────────────────────── other events ─────────────────────────

export async function handlePush(app: App, ev: PushEvent): Promise<void> {
    app.projects.touch(ev.project.id, ev.project.path_with_namespace);
    const channelId = routeChannel(app, ev.project.id);
    if (isMuted(app, ev.project.id) || ignoredActor(app, ev.user_username)) return;
    if (!app.features.isEnabled('cards.push', { channelId, projectId: ev.project.id })) return;
    const zero = /^0+$/;
    const created = zero.test(ev.before);
    const deleted = zero.test(ev.after);
    const branch = ev.ref.replace(/^refs\/heads\//, '');
    const pusher = await personView(app, { username: ev.user_username, name: ev.user_name, email: ev.user_email });
    const projectUrl = ev.project.web_url ?? `${app.cfg.GITLAB_URL}/${ev.project.path_with_namespace}`;
    const post = renderPushCard({
        projectPath: ev.project.path_with_namespace,
        projectUrl,
        branch,
        pusher,
        commits: ev.commits.map((c) => ({ sha: c.id, title: c.title ?? firstLine(c.message ?? ''), author: c.author?.name ?? '', ...(c.url ? { url: c.url } : {}) })),
        total: ev.total_commits_count ?? ev.commits.length,
        compareUrl: created || deleted ? null : `${projectUrl}/-/compare/${shortSha(ev.before)}...${shortSha(ev.after)}`,
        created,
        deleted,
    }, renderOpts(app, channelId));
    if (!created && !deleted && ev.commits.length === 0) return;
    await app.mm.createPost({ ...post, channel_id: channelId });
}

export async function handleTagPush(app: App, ev: TagPushEvent): Promise<void> {
    const channelId = routeChannel(app, ev.project.id);
    if (isMuted(app, ev.project.id) || ignoredActor(app, ev.user_username)) return;
    if (!app.features.isEnabled('cards.tag', { channelId, projectId: ev.project.id })) return;
    const deleted = /^0+$/.test(ev.after);
    const tag = ev.ref.replace(/^refs\/tags\//, '');
    const who = await personView(app, { username: ev.user_username, name: ev.user_name });
    const url = `${ev.project.web_url ?? app.cfg.GITLAB_URL}/-/tags/${encodeURIComponent(tag)}`;
    const post = renderSimpleCard({ emoji: deleted ? '🗑️' : '🏷️', headline: `**Tag ${link(tag, url)} ${deleted ? 'deleted' : 'created'}** by ${who?.mention ?? 'someone'}`, rows: [['Project', link(ev.project.path_with_namespace, ev.project.web_url ?? '')], ['Commit', ev.checkout_sha ? code(shortSha(ev.checkout_sha)) : null], ['Message', ev.message ? truncate(firstLine(ev.message), 120) : null]], color: '#d97706' }, [], renderOpts(app, channelId));
    await app.mm.createPost({ ...post, channel_id: channelId });
}

export async function handleIssue(app: App, ev: IssueEvent): Promise<void> {
    const channelId = routeChannel(app, ev.project.id);
    if (isMuted(app, ev.project.id) || ignoredActor(app, ev.user.username)) return;
    const f = { channelId, projectId: ev.project.id };
    if (!app.features.isEnabled('cards.issue', f)) return;
    const a = ev.object_attributes;
    if (a.action === 'update') return;
    const who = await personView(app, ev.user);
    const assignees = await peopleViews(app, ev.assignees);
    const mentions = app.features.isEnabled('mentions.channel', f);
    const closed = a.action === 'close';
    const post = renderSimpleCard({
        emoji: closed ? '✔️' : '🐞',
        headline: `**Issue ${link(`#${a.iid}`, a.url ?? '')} ${a.action === 'open' ? 'opened' : a.action === 'close' ? 'closed' : a.action === 'reopen' ? 'reopened' : 'updated'}** by ${mentions ? who?.mention : who?.gitlab}`,
        title: `#${a.iid} · ${firstLine(a.title)}`,
        ...(a.url ? { titleLink: a.url } : {}),
        rows: [['Project', link(ev.project.path_with_namespace, ev.project.web_url ?? '')], ['Assignees', assignees.length ? assignees.map((p) => (mentions ? p.mention : p.gitlab)).join(', ') : null], ['Labels', (ev.labels ?? []).map((l) => code(l.title)).join(' ') || null]],
        color: closed ? '#8b5cf6' : '#d97706',
        quote: a.action === 'open' ? a.description : null,
    }, [], renderOpts(app, channelId));
    await upsertCard(app, { kind: 'issue', projectId: ev.project.id, ref: a.iid, channelId, post, state: a.state ?? null });
}

export async function handleNote(app: App, ev: NoteEvent): Promise<void> {
    const n = ev.object_attributes;
    if (n.system || n.noteable_type !== 'MergeRequest' && n.noteable_type !== 'Issue') return;
    const channelId = routeChannel(app, ev.project.id);
    if (isMuted(app, ev.project.id) || ignoredActor(app, ev.user.username)) return;
    const f = { channelId, projectId: ev.project.id };
    const isMr = n.noteable_type === 'MergeRequest';
    const iid = isMr ? ev.merge_request?.iid : ev.issue?.iid;
    const title = isMr ? ev.merge_request?.title : ev.issue?.title;
    if (!iid) return;
    const commenter = await personView(app, ev.user);
    const body = defang(truncate(cleanMessageBody(n.note).replace(/\n+/g, ' '), 400));
    const where = isMr ? `!${iid}` : `#${iid}`;
    const target = link(`${where} ${truncate(title ?? '', 70)}`, n.url ?? '');

    if (app.features.isEnabled('cards.comment', f)) {
        const card = app.cards.get(isMr ? 'mr' : 'issue', ev.project.id, iid, channelId);
        const threaded = app.features.isEnabled('cards.threads', f) && card;
        const message = `💬 **${commenter?.gitlab ?? ev.user.username}** commented on ${target}\n> ${body}`;
        await app.mm.createPost({ channel_id: channelId, message, ...(threaded ? { root_id: card.post_id } : {}) });
    }

    // DMs: MR author + @mentions
    if (app.features.isEnabled('dm.mr_comment')) {
        const targets = new Map<string, { username: string }>();
        if (isMr && ev.merge_request?.author_id) {
            const mr = await fetchMr(app, ev.project.id, iid);
            if (mr) targets.set(mr.author.username, { username: mr.author.username });
        }
        for (const m of n.note.matchAll(/(?:^|\s)@([a-zA-Z0-9_.-]{2,})/g)) targets.set(m[1]!, { username: m[1]! });
        targets.delete(ev.user.username ?? '');
        for (const t of [...targets.values()].slice(0, 6)) {
            const u = await linkedUser(app, t);
            if (u) await sendDm(app, u, 'comment', { message: `💬 **${commenter?.gitlab ?? ev.user.username}** commented on ${target}\n> ${body}` }, eventKey('dm:comment')).catch(() => undefined);
        }
    }
}

export async function handleDeployment(app: App, ev: DeploymentEvent): Promise<void> {
    const channelId = routeChannel(app, ev.project.id);
    if (isMuted(app, ev.project.id) || ignoredActor(app, ev.user?.username)) return;
    if (!app.features.isEnabled('cards.deployment', { channelId, projectId: ev.project.id })) return;
    if (!['success', 'failed', 'canceled'].includes(ev.status)) return;
    const icon = ev.status === 'success' ? '🚀' : ev.status === 'failed' ? '💥' : '⏹️';
    const who = await personView(app, ev.user ?? undefined);
    const post = renderSimpleCard({
        emoji: icon,
        headline: `**Deploy to ${code(ev.environment)} ${ev.status === 'success' ? 'succeeded' : ev.status}**${who ? ` — ${who.mention}` : ''}`,
        rows: [['Project', link(ev.project.path_with_namespace, ev.project.web_url ?? '')], ['Commit', ev.short_sha ? (ev.commit_url ? link(code(ev.short_sha), ev.commit_url) : code(ev.short_sha)) : null], ['Title', ev.commit_title ? truncate(firstLine(ev.commit_title), 100) : null], ['Job', ev.deployable_url ? link('open', ev.deployable_url) : null]],
        color: ev.status === 'success' ? '#2da44e' : '#dd2b0e',
    }, [], renderOpts(app, channelId));
    await app.mm.createPost({ ...post, channel_id: channelId });
}

export async function handleRelease(app: App, ev: ReleaseEvent): Promise<void> {
    const channelId = routeChannel(app, ev.project.id);
    if (isMuted(app, ev.project.id)) return;
    if (!app.features.isEnabled('cards.release', { channelId, projectId: ev.project.id })) return;
    if (ev.action && ev.action !== 'create') return;
    const post = renderSimpleCard({ emoji: '📦', headline: `**Release ${link(ev.name || ev.tag, ev.url ?? '')} published**`, rows: [['Project', link(ev.project.path_with_namespace, ev.project.web_url ?? '')], ['Tag', code(ev.tag)]], color: '#8b5cf6', quote: ev.description }, [], renderOpts(app, channelId));
    await app.mm.createPost({ ...post, channel_id: channelId });
}

export async function dispatchEvent(app: App, ev: GitlabEvent): Promise<void> {
    try {
        await dispatchInner(app, ev);
    } finally {
        await flushOutbox(app); // deliver DMs / logs / pings queued by this event right away
    }
}

async function dispatchInner(app: App, ev: GitlabEvent): Promise<void> {
    switch (ev.object_kind) {
        case 'merge_request': return handleMergeRequest(app, ev);
        case 'pipeline': return handlePipeline(app, ev);
        case 'note': return handleNote(app, ev);
        case 'push': return handlePush(app, ev);
        case 'tag_push': return handleTagPush(app, ev);
        case 'issue': return handleIssue(app, ev);
        case 'deployment': return handleDeployment(app, ev);
        case 'release': return handleRelease(app, ev);
    }
}

export type { PersonView };
