import type { App } from '../app.ts';
import { log, errMsg } from '../logger.ts';
import { renderLogPost } from '../render/cards.ts';
import { maskSecrets, stripAnsi, stripSectionMarkers, tailLines } from '../util/text.ts';
import type { GlJob } from '../gitlab/client.ts';

export interface PreparedLog {
    job: GlJob;
    tail: string;
    full: string;
    truncated: boolean;
}

export function prepareLog(app: App, raw: string): { tail: string; full: string; truncated: boolean } {
    const cleaned = stripSectionMarkers(stripAnsi(raw)).replace(/\n{3,}/g, '\n\n');
    const mask = app.features.isEnabled('pipeline.mask_secrets');
    const full = mask ? maskSecrets(cleaned, app.cfg.MASK_LITERALS) : cleaned;
    const lines = app.cfg.FAILURE_LOG_LINES;
    const tail = tailLines(full, lines);
    // Mattermost posts are capped (16383 chars); keep headroom for headers.
    const safeTail = tail.length > 12_000 ? '…' + tail.slice(-12_000) : tail;
    return { tail: safeTail, full, truncated: full.split('\n').length > lines || safeTail !== tail };
}

/** Fetch failed job traces for a pipeline and return posts-ready content. */
export async function collectFailureLogs(app: App, projectId: number, pipelineId: number, opts: { includeAllowed?: boolean } = {}): Promise<PreparedLog[]> {
    const jobs = await app.gl.listPipelineJobs(projectId, pipelineId);
    // Automatic posts skip allow_failure jobs; an explicit "Show logs" click includes them (real failures first).
    const failed = jobs
        .filter((j) => j.status === 'failed' && (opts.includeAllowed || !j.allow_failure))
        .sort((a, b) => Number(!!a.allow_failure) - Number(!!b.allow_failure))
        .slice(0, app.cfg.FAILURE_LOG_MAX_JOBS);
    const out: PreparedLog[] = [];
    for (const job of failed) {
        try {
            const raw = await app.gl.getJobTrace(projectId, job.id);
            out.push({ job, ...prepareLog(app, raw) });
        } catch (e) {
            log.warn('could not fetch job trace', { jobId: job.id, err: errMsg(e) });
        }
    }
    return out;
}

/** Post the failed job logs as thread replies (or plain replies) under `rootId`. */
export async function postFailureLogs(app: App, input: { projectId: number; pipelineId: number; channelId: string; rootId: string | null }): Promise<number> {
    if (!app.features.isEnabled('pipeline.failure_logs', { channelId: input.channelId, projectId: input.projectId })) return 0;
    const logs = await collectFailureLogs(app, input.projectId, input.pipelineId);
    const threaded = app.features.isEnabled('cards.threads', { channelId: input.channelId });
    let posted = 0;
    for (const l of logs) {
        const wantFile = app.features.isEnabled('pipeline.log_file') && l.truncated;
        const fileIds: string[] = [];
        if (wantFile) {
            try {
                fileIds.push(await app.mm.uploadFile(input.channelId, `job-${l.job.id}-${l.job.name.replace(/[^\w.-]+/g, '_')}.log`, l.full));
            } catch (e) {
                log.warn('log upload failed', { err: errMsg(e) });
            }
        }
        const message = renderLogPost({
            jobName: l.job.name,
            jobUrl: l.job.web_url,
            stage: l.job.stage,
            reason: l.job.failure_reason ?? null,
            lines: app.cfg.FAILURE_LOG_LINES,
            truncated: l.truncated,
            log: l.tail || '(empty log)',
            fileNote: fileIds.length ? 'full log attached' : null,
        });
        await app.mm.createPost({
            channel_id: input.channelId,
            message,
            ...(threaded && input.rootId ? { root_id: input.rootId } : {}),
            ...(fileIds.length ? { file_ids: fileIds } : {}),
        });
        posted++;
    }
    return posted;
}
