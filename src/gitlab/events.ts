import { z } from 'zod';

const user = z.looseObject({
    id: z.number().optional(),
    name: z.string().optional(),
    username: z.string().optional(),
    avatar_url: z.string().nullish(),
    email: z.string().nullish(),
});

const project = z.looseObject({
    id: z.number(),
    name: z.string().optional(),
    path_with_namespace: z.string(),
    web_url: z.string().optional(),
    default_branch: z.string().nullish(),
});

const commit = z.looseObject({
    id: z.string(),
    message: z.string().optional(),
    title: z.string().optional(),
    timestamp: z.string().optional(),
    url: z.string().optional(),
    author: z.looseObject({ name: z.string().optional(), email: z.string().optional() }).optional(),
});

const mrRef = z.looseObject({
    id: z.number().optional(),
    iid: z.number(),
    title: z.string().optional(),
    url: z.string().optional(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
    state: z.string().optional(),
    author_id: z.number().optional(),
    draft: z.boolean().optional(),
    merge_commit_sha: z.string().nullish(),
});

const person = z.looseObject({
    id: z.number().optional(),
    name: z.string().optional(),
    username: z.string(),
    avatar_url: z.string().nullish(),
    email: z.string().nullish(),
});

const label = z.looseObject({ title: z.string() });

export const mergeRequestEvent = z.looseObject({
    object_kind: z.literal('merge_request'),
    user,
    project,
    object_attributes: mrRef.extend({
        description: z.string().nullish(),
        action: z.string().optional(),
        last_commit: commit.nullish(),
        detailed_merge_status: z.string().nullish(),
        oldrev: z.string().nullish(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
    }),
    assignees: z.array(person).optional(),
    reviewers: z.array(person).optional(),
    labels: z.array(label).optional(),
    changes: z.looseObject({}).optional(),
});

export const pipelineBuild = z.looseObject({
    id: z.number(),
    stage: z.string().optional(),
    name: z.string(),
    status: z.string(),
    duration: z.number().nullish(),
    allow_failure: z.boolean().optional(),
    failure_reason: z.string().nullish(),
    environment: z.looseObject({ name: z.string().optional() }).nullish(),
});

export const pipelineEvent = z.looseObject({
    object_kind: z.literal('pipeline'),
    user: user.nullish(),
    project,
    object_attributes: z.looseObject({
        id: z.number(),
        iid: z.number().optional(),
        ref: z.string(),
        tag: z.boolean().optional(),
        sha: z.string(),
        source: z.string().nullish(),
        status: z.string(),
        detailed_status: z.string().nullish(),
        created_at: z.string().nullish(),
        finished_at: z.string().nullish(),
        duration: z.number().nullish(),
        queued_duration: z.number().nullish(),
        name: z.string().nullish(),
    }),
    merge_request: mrRef.nullish(),
    commit: commit.nullish(),
    builds: z.array(pipelineBuild).optional(),
});

export const noteEvent = z.looseObject({
    object_kind: z.literal('note'),
    user,
    project,
    object_attributes: z.looseObject({
        id: z.number(),
        note: z.string(),
        noteable_type: z.string(),
        url: z.string().optional(),
        action: z.string().optional(),
        system: z.boolean().optional(),
    }),
    merge_request: mrRef.nullish(),
    issue: z.looseObject({ iid: z.number(), title: z.string().optional(), author_id: z.number().optional() }).nullish(),
    commit: commit.nullish(),
});

export const pushEvent = z.looseObject({
    object_kind: z.literal('push'),
    before: z.string(),
    after: z.string(),
    ref: z.string(),
    user_name: z.string().optional(),
    user_username: z.string().optional(),
    user_email: z.string().nullish(),
    user_avatar: z.string().nullish(),
    total_commits_count: z.number().optional(),
    commits: z.array(commit).default([]),
    project,
});

export const tagPushEvent = z.looseObject({
    object_kind: z.literal('tag_push'),
    before: z.string(),
    after: z.string(),
    ref: z.string(),
    checkout_sha: z.string().nullish(),
    user_name: z.string().optional(),
    user_username: z.string().optional(),
    message: z.string().nullish(),
    project,
});

export const issueEvent = z.looseObject({
    object_kind: z.literal('issue'),
    user,
    project,
    object_attributes: z.looseObject({
        iid: z.number(),
        title: z.string(),
        state: z.string().optional(),
        action: z.string().optional(),
        url: z.string().optional(),
        description: z.string().nullish(),
    }),
    assignees: z.array(person).optional(),
    labels: z.array(label).optional(),
});

export const deploymentEvent = z.looseObject({
    object_kind: z.literal('deployment'),
    status: z.string(),
    environment: z.string(),
    deployable_url: z.string().nullish(),
    short_sha: z.string().optional(),
    commit_url: z.string().nullish(),
    commit_title: z.string().nullish(),
    user: user.nullish(),
    project,
});

export const releaseEvent = z.looseObject({
    object_kind: z.literal('release'),
    action: z.string().optional(),
    name: z.string().nullish(),
    tag: z.string(),
    url: z.string().optional(),
    description: z.string().nullish(),
    project,
});

export type MergeRequestEvent = z.infer<typeof mergeRequestEvent>;
export type PipelineEvent = z.infer<typeof pipelineEvent>;
export type NoteEvent = z.infer<typeof noteEvent>;
export type PushEvent = z.infer<typeof pushEvent>;
export type TagPushEvent = z.infer<typeof tagPushEvent>;
export type IssueEvent = z.infer<typeof issueEvent>;
export type DeploymentEvent = z.infer<typeof deploymentEvent>;
export type ReleaseEvent = z.infer<typeof releaseEvent>;

export type GitlabEvent =
    | MergeRequestEvent
    | PipelineEvent
    | NoteEvent
    | PushEvent
    | TagPushEvent
    | IssueEvent
    | DeploymentEvent
    | ReleaseEvent;

const SCHEMAS = {
    merge_request: mergeRequestEvent,
    pipeline: pipelineEvent,
    note: noteEvent,
    push: pushEvent,
    tag_push: tagPushEvent,
    issue: issueEvent,
    deployment: deploymentEvent,
    release: releaseEvent,
} as const;

export function parseEvent(payload: unknown): { ok: true; event: GitlabEvent } | { ok: false; reason: string } {
    const kind = (payload as { object_kind?: string } | null)?.object_kind;
    if (!kind || !(kind in SCHEMAS)) return { ok: false, reason: `unsupported object_kind: ${String(kind)}` };
    const schema = SCHEMAS[kind as keyof typeof SCHEMAS];
    const res = schema.safeParse(payload);
    if (!res.success) return { ok: false, reason: res.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    return { ok: true, event: res.data as GitlabEvent };
}

export const TERMINAL_PIPELINE = new Set(['success', 'failed', 'canceled', 'skipped']);
export const isTerminalPipeline = (s: string): boolean => TERMINAL_PIPELINE.has(s);
