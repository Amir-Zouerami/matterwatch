import type { App } from '../app.ts';
import { verifyContext } from '../mattermost/sign.ts';
import { log, errMsg } from '../logger.ts';
import { link } from '../render/table.ts';
import { collectFailureLogs } from './failure-logs.ts';
import { renderLogPost } from '../render/cards.ts';

export interface ActionRequest {
    user_id: string;
    user_name?: string;
    channel_id: string;
    post_id: string;
    context: Record<string, unknown>;
}

export interface ActionResponse {
    ephemeral_text?: string;
}

const WRITE_ACTIONS: Record<string, string> = {
    retry_pipeline: 'actions.retry',
    cancel_pipeline: 'actions.cancel',
    merge_mr: 'actions.merge',
    approve_mr: 'actions.approve',
};
const READ_ACTIONS: Record<string, string> = { show_logs: 'actions.logs' };

/** Background work started by a button press (tests await it via settleActions). */
const running = new Set<Promise<void>>();
function trackAction(p: Promise<void>): void {
    running.add(p);
    void p.finally(() => running.delete(p));
}
export async function settleActions(): Promise<void> {
    await Promise.allSettled([...running]);
}

export async function isAdmin(app: App, mmUserId: string): Promise<boolean> {
    const u = await app.mm.userById(mmUserId).catch(() => null);
    return !!u && u.roles.split(' ').includes('system_admin');
}

export async function handleAction(app: App, req: ActionRequest): Promise<ActionResponse> {
    const ctx = req.context ?? {};
    if (!verifyContext(app.cfg.ACTION_SIGNING_SECRET, ctx)) {
        log.warn('action with bad signature', { user: req.user_id });
        return { ephemeral_text: '⚠️ This button is no longer valid.' };
    }
    const action = String(ctx['action']);
    const feature = WRITE_ACTIONS[action] ?? READ_ACTIONS[action];
    if (!feature) return { ephemeral_text: 'Unknown action.' };
    const projectId = Number(ctx['projectId']);
    const projectPath = String(ctx['projectPath']);
    if (!app.features.isEnabled(feature, { channelId: req.channel_id, projectId, userId: req.user_id })) {
        return { ephemeral_text: `🔕 This action is switched off (\`${feature}\`).` };
    }

    const write = action in WRITE_ACTIONS;
    const actor = app.users.byMm(req.user_id);
    if (write && app.features.isEnabled('actions.require_linked_user') && !actor && !(await isAdmin(app, req.user_id))) {
        return { ephemeral_text: '🔐 Link your GitLab account first: `/gl link <your-gitlab-username>`.' };
    }
    const who = actor?.gitlab_username ?? req.user_name ?? req.user_id;
    // Button results are ALWAYS a reply to the card (channels and DMs alike) — the user asked for this explicitly.
    const threaded = { channel_id: req.channel_id, root_id: req.post_id };

    try {
        switch (action) {
            case 'retry_pipeline': {
                const p = await app.gl.retryPipeline(projectId, Number(ctx['pipelineId']));
                app.audit.record({ actorMm: req.user_id, actorGl: who, action, target: `${projectPath}#${p.id}`, result: 'ok' });
                await app.mm.createPost({ ...threaded, message: `🔁 @${req.user_name ?? who} retried pipeline ${link(`#${p.id}`, p.web_url)}` });
                return { ephemeral_text: `Retrying pipeline #${p.id}.` };
            }
            case 'cancel_pipeline': {
                const p = await app.gl.cancelPipeline(projectId, Number(ctx['pipelineId']));
                app.audit.record({ actorMm: req.user_id, actorGl: who, action, target: `${projectPath}#${p.id}`, result: 'ok' });
                await app.mm.createPost({ ...threaded, message: `⏹️ @${req.user_name ?? who} canceled pipeline ${link(`#${p.id}`, p.web_url)}` });
                return { ephemeral_text: `Canceled pipeline #${p.id}.` };
            }
            case 'approve_mr': {
                const iid = Number(ctx['iid']);
                await app.gl.approveMr(projectId, iid);
                app.audit.record({ actorMm: req.user_id, actorGl: who, action, target: `${projectPath}!${iid}`, result: 'ok' });
                await app.mm.createPost({ ...threaded, message: `👍 @${req.user_name ?? who} approved !${iid} (via the service account)` });
                return { ephemeral_text: `Approved !${iid}.` };
            }
            case 'merge_mr': {
                const iid = Number(ctx['iid']);
                const mr = await app.gl.getMr(projectId, iid);
                if (mr.state !== 'opened') return { ephemeral_text: `!${iid} is ${mr.state}.` };
                const green = mr.head_pipeline?.status === 'success';
                await app.gl.mergeMr(projectId, iid, !green);
                app.audit.record({ actorMm: req.user_id, actorGl: who, action, target: `${projectPath}!${iid}`, result: green ? 'merged' : 'merge-when-green' });
                await app.mm.createPost({ ...threaded, message: green ? `🚀 @${req.user_name ?? who} merged !${iid}` : `🚀 @${req.user_name ?? who} set !${iid} to merge when the pipeline succeeds` });
                return { ephemeral_text: green ? `Merged !${iid}.` : `!${iid} will merge when its pipeline succeeds.` };
            }
            case 'show_logs': {
                // Answer instantly (Mattermost shows nothing until we do), then fetch and post the logs.
                const pipelineId = Number(ctx['pipelineId']);
                trackAction(
                    (async () => {
                        try {
                            const logs = await collectFailureLogs(app, projectId, pipelineId, { includeAllowed: true });
                            if (logs.length === 0) {
                                await app.mm.createPost({ ...threaded, message: `🔎 This pipeline (#${pipelineId}) has no failed jobs (it may have been retried).` });
                                return;
                            }
                            for (const l of logs) {
                                await app.mm.createPost({
                                    ...threaded,
                                    message: renderLogPost({ jobName: l.job.name, jobUrl: l.job.web_url, stage: l.job.stage, reason: l.job.failure_reason ?? null, lines: app.cfg.FAILURE_LOG_LINES, truncated: l.truncated, log: l.tail || '(empty log)', fileNote: null }),
                                });
                            }
                        } catch (e) {
                            log.warn('show logs failed', { err: errMsg(e) });
                            await app.mm.createPost({ ...threaded, message: `❌ Could not fetch the logs: ${errMsg(e).replace(/^GitLab \d+ on [A-Z]+ \S+:\s*/, '').slice(0, 200)}` }).catch(() => undefined);
                        }
                    })(),
                );
                return { ephemeral_text: '🔎 Fetching the failed job logs…' };
            }
        }
    } catch (e) {
        app.audit.record({ actorMm: req.user_id, actorGl: who, action, target: projectPath, result: `error: ${errMsg(e).slice(0, 200)}` });
        log.warn('action failed', { action, err: errMsg(e) });
        return { ephemeral_text: `❌ GitLab refused: ${errMsg(e).replace(/^GitLab \d+ on [A-Z]+ \S+:\s*/, '').slice(0, 250)}` };
    }
    return { ephemeral_text: 'Done.' };
}
