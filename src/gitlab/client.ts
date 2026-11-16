import { log } from '../logger.ts';
import { backoffMs, sleep } from '../util/async.ts';

export class GitlabError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export interface GlUser {
    id: number;
    username: string;
    name: string;
    avatar_url?: string | null;
    public_email?: string | null;
}

export interface GlProject {
    id: number;
    path_with_namespace: string;
    web_url: string;
    default_branch?: string | null;
}

export interface GlMr {
    id: number;
    iid: number;
    project_id: number;
    title: string;
    description?: string | null;
    state: string;
    draft?: boolean;
    web_url: string;
    source_branch: string;
    target_branch: string;
    author: GlUser;
    assignees?: GlUser[];
    reviewers?: GlUser[];
    labels?: string[];
    sha?: string;
    merge_commit_sha?: string | null;
    squash_commit_sha?: string | null;
    merged_at?: string | null;
    created_at: string;
    updated_at: string;
    detailed_merge_status?: string;
    head_pipeline?: GlPipeline | null;
    user_notes_count?: number;
    has_conflicts?: boolean;
}

export interface GlPipeline {
    id: number;
    iid?: number;
    project_id: number;
    status: string;
    ref: string;
    sha: string;
    web_url: string;
    source?: string;
    created_at?: string;
    started_at?: string | null;
    finished_at?: string | null;
    duration?: number | null;
    user?: GlUser | null;
}

export interface GlJob {
    id: number;
    name: string;
    stage: string;
    status: string;
    allow_failure: boolean;
    failure_reason?: string | null;
    duration?: number | null;
    web_url: string;
    pipeline?: { id: number };
}

export interface GitlabApi {
    getProject(idOrPath: string | number): Promise<GlProject>;
    getMr(project: string | number, iid: number): Promise<GlMr>;
    listMrs(params: { state?: string; scope?: string; projectId?: number; perPage?: number; authorUsername?: string; reviewerUsername?: string; updatedAfter?: string }): Promise<GlMr[]>;
    getPipeline(project: string | number, id: number): Promise<GlPipeline>;
    listMrPipelines(project: string | number, iid: number): Promise<GlPipeline[]>;
    listPipelineJobs(project: string | number, pipelineId: number): Promise<GlJob[]>;
    listPipelinesBySha(project: string | number, sha: string): Promise<GlPipeline[]>;
    listCommitMrs(project: string | number, sha: string): Promise<GlMr[]>;
    getJobTrace(project: string | number, jobId: number): Promise<string>;
    retryPipeline(project: string | number, pipelineId: number): Promise<GlPipeline>;
    cancelPipeline(project: string | number, pipelineId: number): Promise<GlPipeline>;
    retryJob(project: string | number, jobId: number): Promise<GlJob>;
    approveMr(project: string | number, iid: number): Promise<void>;
    mergeMr(project: string | number, iid: number, whenPipelineSucceeds: boolean): Promise<GlMr>;
    findUserByUsername(username: string): Promise<GlUser | null>;
    listGroupProjects(group: string): Promise<GlProject[]>;
    listProjectHooks(project: string | number): Promise<{ id: number; url: string }[]>;
    addProjectHook(project: string | number, hook: Record<string, unknown>): Promise<{ id: number }>;
    updateProjectHook(project: string | number, hookId: number, hook: Record<string, unknown>): Promise<{ id: number }>;
}

const enc = (p: string | number): string => encodeURIComponent(String(p));

export const TRACE_MAX_BYTES = 512 * 1024;

/**
 * Read a response body but keep only its last `max` bytes. Servers may ignore the Range header and send a
 * multi-megabyte log; never hold more than `max` (plus one chunk) in memory.
 */
export async function readTail(res: Response, max: number): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    let chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
        while (size - chunks[0]!.byteLength >= max && chunks.length > 1) size -= chunks.shift()!.byteLength;
    }
    const all = Buffer.concat(chunks);
    chunks = [];
    const tail = all.byteLength > max ? all.subarray(all.byteLength - max) : all;
    return tail.toString('utf8');
}

export class GitlabClient implements GitlabApi {
    private readonly baseUrl: string;
    private readonly token: string;
    constructor(baseUrl: string, token: string) {
        this.baseUrl = baseUrl;
        this.token = token;}

    private async req<T>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown; text?: boolean; maxBytes?: number } = {}): Promise<T> {
        const url = new URL(`${this.baseUrl}/api/v4${path}`);
        for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const headers: Record<string, string> = { 'PRIVATE-TOKEN': this.token, Accept: 'application/json' };
                if (opts.maxBytes) headers['Range'] = `bytes=-${opts.maxBytes}`;
                const init: RequestInit = { method, headers, signal: AbortSignal.timeout(20_000) };
                if (opts.body !== undefined) {
                    headers['Content-Type'] = 'application/json';
                    init.body = JSON.stringify(opts.body);
                }
                const res = await fetch(url, init);
                if (res.status === 429 || res.status >= 500) throw new GitlabError(`GitLab ${res.status} on ${method} ${path}`, res.status);
                if (!res.ok && res.status !== 206) {
                    const body = await res.text().catch(() => '');
                    throw new GitlabError(`GitLab ${res.status} on ${method} ${path}: ${body.slice(0, 300)}`, res.status);
                }
                if (opts.text) return (await res.text()) as T;
                if (res.status === 204) return undefined as T;
                return (await res.json()) as T;
            } catch (e) {
                lastErr = e;
                const retryable = !(e instanceof GitlabError) || e.status === 429 || e.status >= 500;
                if (!retryable || attempt === 3) break;
                log.debug('gitlab retry', { path, attempt });
                await sleep(backoffMs(attempt, 500, 5000));
            }
        }
        throw lastErr;
    }

    getProject = (p: string | number) => this.req<GlProject>('GET', `/projects/${enc(p)}`);
    getMr = (p: string | number, iid: number) => this.req<GlMr>('GET', `/projects/${enc(p)}/merge_requests/${iid}`);
    listMrs = (q: { state?: string; scope?: string; projectId?: number; perPage?: number; authorUsername?: string; reviewerUsername?: string; updatedAfter?: string }) =>
        this.req<GlMr[]>('GET', q.projectId ? `/projects/${q.projectId}/merge_requests` : '/merge_requests', {
            query: {
                state: q.state ?? 'opened',
                scope: q.projectId ? undefined : (q.scope ?? 'all'),
                per_page: q.perPage ?? 50,
                order_by: 'updated_at',
                author_username: q.authorUsername,
                reviewer_username: q.reviewerUsername,
                updated_after: q.updatedAfter,
            },
        });
    getPipeline = (p: string | number, id: number) => this.req<GlPipeline>('GET', `/projects/${enc(p)}/pipelines/${id}`);
    listMrPipelines = (p: string | number, iid: number) => this.req<GlPipeline[]>('GET', `/projects/${enc(p)}/merge_requests/${iid}/pipelines`);
    listPipelineJobs = (p: string | number, id: number) =>
        this.req<GlJob[]>('GET', `/projects/${enc(p)}/pipelines/${id}/jobs`, { query: { per_page: 100 } });
    listPipelinesBySha = (p: string | number, sha: string) =>
        this.req<GlPipeline[]>('GET', `/projects/${enc(p)}/pipelines`, { query: { sha, per_page: 10, order_by: 'id', sort: 'desc' } });
    listCommitMrs = (p: string | number, sha: string) => this.req<GlMr[]>('GET', `/projects/${enc(p)}/repository/commits/${sha}/merge_requests`);
    async getJobTrace(p: string | number, jobId: number): Promise<string> {
        const res = await fetch(`${this.baseUrl}/api/v4/projects/${enc(p)}/jobs/${jobId}/trace`, {
            headers: { 'PRIVATE-TOKEN': this.token, Range: `bytes=-${TRACE_MAX_BYTES}` },
            signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok && res.status !== 206) throw new GitlabError(`GitLab ${res.status} on GET job trace ${jobId}`, res.status);
        return readTail(res, TRACE_MAX_BYTES);
    }
    retryPipeline = (p: string | number, id: number) => this.req<GlPipeline>('POST', `/projects/${enc(p)}/pipelines/${id}/retry`);
    cancelPipeline = (p: string | number, id: number) => this.req<GlPipeline>('POST', `/projects/${enc(p)}/pipelines/${id}/cancel`);
    retryJob = (p: string | number, id: number) => this.req<GlJob>('POST', `/projects/${enc(p)}/jobs/${id}/retry`);
    approveMr = async (p: string | number, iid: number) => {
        await this.req('POST', `/projects/${enc(p)}/merge_requests/${iid}/approve`);
    };
    mergeMr = (p: string | number, iid: number, whenPipelineSucceeds: boolean) =>
        this.req<GlMr>('PUT', `/projects/${enc(p)}/merge_requests/${iid}/merge`, {
            body: { merge_when_pipeline_succeeds: whenPipelineSucceeds },
        });
    findUserByUsername = async (username: string) => {
        const list = await this.req<GlUser[]>('GET', '/users', { query: { username } });
        return list[0] ?? null;
    };
    listGroupProjects = (group: string) =>
        this.req<GlProject[]>('GET', `/groups/${enc(group)}/projects`, { query: { include_subgroups: 'true', per_page: 100, archived: 'false' } });
    listProjectHooks = (p: string | number) => this.req<{ id: number; url: string }[]>('GET', `/projects/${enc(p)}/hooks`);
    addProjectHook = (p: string | number, hook: Record<string, unknown>) =>
        this.req<{ id: number }>('POST', `/projects/${enc(p)}/hooks`, { body: hook });
    updateProjectHook = (p: string | number, id: number, hook: Record<string, unknown>) =>
        this.req<{ id: number }>('PUT', `/projects/${enc(p)}/hooks/${id}`, { body: hook });
}
