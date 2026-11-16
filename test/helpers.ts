import type { App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { Features } from '../src/features/service.ts';
import type { GitlabApi, GlJob, GlMr, GlPipeline, GlProject } from '../src/gitlab/client.ts';
import type { MattermostApi, MmPost, MmUser, OutPost } from '../src/mattermost/types.ts';
import { AuditStore, CardsStore, OnceStore, ProjectsStore, SettingsStore, WatchesStore } from '../src/domain/stores.ts';
import { UsersStore } from '../src/domain/users.ts';

export const UPDATES = 'chan_updates';
export const GENERAL = 'chan_general';

export class FakeMm implements MattermostApi {
    posts: (MmPost & { props?: OutPost['props'] })[] = [];
    patches: { id: string; message?: string | undefined; props?: OutPost['props'] | undefined }[] = [];
    reactions: { postId: string; emoji: string; removed?: boolean }[] = [];
    dms: { userId: string; post: OutPost }[] = [];
    files: { name: string; content: string }[] = [];
    users: MmUser[] = [
        { id: 'u_alice', username: 'alice.dev', email: 'alice@example.com', roles: 'system_user system_admin' },
        { id: 'u_sara', username: 'sara', email: 'sara@example.com', roles: 'system_user' },
        { id: 'u_bob', username: 'bob', email: 'bob@example.com', roles: 'system_user' },
    ];
    private n = 0;
    bot: MmUser = { id: 'bot', username: 'gitlab-bot', roles: 'system_user', is_bot: true };

    me = async () => this.bot;
    createPost = async (p: OutPost) => {
        const post = { id: `p${++this.n}`, user_id: this.bot.id, channel_id: p.channel_id, message: p.message, root_id: p.root_id ?? '', props: p.props };
        this.posts.push(post);
        return post;
    };
    patchPost = async (id: string, patch: { message?: string; props?: OutPost['props'] }) => {
        this.patches.push({ id, message: patch.message, props: patch.props });
        const post = this.posts.find((x) => x.id === id);
        if (!post) throw new Error('404');
        if (patch.message !== undefined) post.message = patch.message;
        post.props = patch.props;
        return post;
    };
    getPost = async (id: string) => this.posts.find((x) => x.id === id)!;
    missed: MmPost[] = [];
    postsSince = async () => this.missed;
    deletePost = async () => undefined;
    dmChannel = async (userId: string) => `dm_${userId}`;
    userByEmail = async (e: string) => this.users.find((u) => u.email === e) ?? null;
    userByUsername = async (n: string) => this.users.find((u) => u.username === n) ?? null;
    userById = async (id: string) => this.users.find((u) => u.id === id) ?? null;
    addReaction = async (postId: string, emoji: string) => void this.reactions.push({ postId, emoji });
    removeReaction = async (postId: string, emoji: string) => void this.reactions.push({ postId, emoji, removed: true });
    uploadFile = async (_c: string, name: string, content: string) => {
        this.files.push({ name, content });
        return `file${this.files.length}`;
    };
    addSelfToTeam = async () => undefined;
    addSelfToChannel = async () => undefined;
    isChannelMember = async () => true;
    getTeamByName = async () => ({ id: 'team' });
    ensureCommand = async () => ({ token: 'slashtoken' });
    ephemeral = async () => undefined;

    inChannel(id: string) {
        return this.posts.filter((p) => p.channel_id === id);
    }
    dmsTo(userId: string) {
        return this.posts.filter((p) => p.channel_id === `dm_${userId}`);
    }
}

export class FakeGl implements GitlabApi {
    project: GlProject = { id: 7, path_with_namespace: 'acme/front-end/product/sections_project', web_url: 'https://gitlab.example.com/acme/front-end/product/sections_project' };
    mr: GlMr = {
        id: 900, iid: 822, project_id: 7, title: 'feat(sections): add hero', state: 'opened', web_url: `${this.project.web_url}/-/merge_requests/822`,
        source_branch: 'feat/hero', target_branch: 'master', author: { id: 1, username: 'alice.dev', name: 'Alice' }, reviewers: [], created_at: '2026-11-14T07:00:00Z', updated_at: '2026-11-14T07:00:00Z',
        head_pipeline: null,
    };
    pipelines = new Map<number, GlPipeline>();
    jobs = new Map<number, GlJob[]>();
    traces = new Map<number, string>();
    calls: string[] = [];

    getProject = async () => this.project;
    getMr = async () => this.mr;
    listMrs = async () => [this.mr];
    getPipeline = async (_p: string | number, id: number) => this.pipelines.get(id)!;
    listMrPipelines = async () => [...this.pipelines.values()];
    listPipelineJobs = async (_p: string | number, id: number) => this.jobs.get(id) ?? [];
    listPipelinesBySha = async (_p: string | number, sha: string) => [...this.pipelines.values()].filter((p) => p.sha === sha);
    commitMrs: GlMr[] = [];
    listCommitMrs = async () => this.commitMrs;
    getJobTrace = async (_p: string | number, id: number) => this.traces.get(id) ?? '';
    retryPipeline = async (_p: string | number, id: number) => (this.calls.push(`retry:${id}`), { ...this.pipelines.get(id)!, status: 'pending' });
    cancelPipeline = async (_p: string | number, id: number) => (this.calls.push(`cancel:${id}`), this.pipelines.get(id)!);
    retryJob = async () => ({}) as GlJob;
    approveMr = async (_p: string | number, iid: number) => void this.calls.push(`approve:${iid}`);
    mergeMr = async (_p: string | number, iid: number, when: boolean) => (this.calls.push(`merge:${iid}:${when}`), this.mr);
    findUserByUsername = async (u: string) => ({ id: 1, username: u, name: u, public_email: u === 'alice.dev' ? 'alice@example.com' : null });
    listGroupProjects = async () => [this.project];
    listProjectHooks = async () => [];
    addProjectHook = async () => ({ id: 1 });
    updateProjectHook = async () => ({ id: 1 });
}

export function makeApp(env: Record<string, string> = {}): { app: App; mm: FakeMm; gl: FakeGl } {
    const cfg = loadConfig({
        MM_TOKEN: 't', GITLAB_TOKEN: 't', GITLAB_WEBHOOK_SECRET: 'whsecret', ADMIN_TOKEN: 'admintoken', ACTION_SIGNING_SECRET: 'signsecret',
        MM_UPDATES_CHANNEL_ID: UPDATES, MM_WATCH_CHANNEL_IDS: GENERAL, GITLAB_URL: 'https://gitlab.example.com', SERVICE_URL: 'https://bot.example',
        QUIET_HOURS_START: '0', QUIET_HOURS_END: '0', // quiet hours off unless a test sets them
        ...env,
    });
    const db = openDb(':memory:');
    const mm = new FakeMm();
    const gl = new FakeGl();
    const app: App = {
        cfg, db, features: new Features(db), gl, mm, users: new UsersStore(db, mm), cards: new CardsStore(db),
        watches: new WatchesStore(db, cfg.WATCH_TTL_HOURS), settings: new SettingsStore(db), projects: new ProjectsStore(db),
        audit: new AuditStore(db), once: new OnceStore(db), bot: mm.bot, slashToken: () => 'slashtoken',
    };
    return { app, mm, gl };
}

export const PROJECT = {
    id: 7, name: 'sections_project', path_with_namespace: 'acme/front-end/product/sections_project',
    web_url: 'https://gitlab.example.com/acme/front-end/product/sections_project', default_branch: 'master',
};

export function pipelineEvent(over: { id?: number; status?: string; mrIid?: number | null; sha?: string; user?: string; builds?: unknown[] } = {}) {
    return {
        object_kind: 'pipeline',
        user: { id: 1, name: 'Alice', username: over.user ?? 'alice.dev', email: 'alice@example.com' },
        project: PROJECT,
        object_attributes: { id: over.id ?? 100, ref: 'feat/hero', tag: false, sha: over.sha ?? 'a'.repeat(40), source: 'merge_request_event', status: over.status ?? 'running', duration: 125, finished_at: '2026-11-14 07:10:00 UTC' },
        merge_request: over.mrIid === null ? null : { iid: over.mrIid ?? 822, title: 'feat(sections): add hero', url: `${PROJECT.web_url}/-/merge_requests/${over.mrIid ?? 822}`, source_branch: 'feat/hero', target_branch: 'master', state: 'opened' },
        commit: { id: over.sha ?? 'a'.repeat(40), title: 'feat(sections): add hero', message: 'feat(sections): add hero\n\nCo-Authored-By: Jane Doe <jane@example.com>' },
        builds: over.builds ?? [
            { id: 1, stage: 'build', name: 'build', status: 'success', duration: 40 },
            { id: 2, stage: 'test', name: 'unit-tests', status: over.status === 'failed' ? 'failed' : 'success', duration: 60, allow_failure: false },
        ],
    };
}
