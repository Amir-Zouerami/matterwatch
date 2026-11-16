import { log } from '../logger.ts';
import { backoffMs, sleep } from '../util/async.ts';
import type { MattermostApi, MmPost, MmUser, OutPost } from './types.ts';

export class MattermostError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

/** Mattermost rejects posts over 16383 characters. */
const clamp = (m: string): string => (m.length > 16_000 ? m.slice(0, 15_990) + '\n…(cut)' : m);

export class MattermostClient implements MattermostApi {
    private meCache: MmUser | null = null;

    private readonly baseUrl: string;
    private readonly token: string;
    constructor(baseUrl: string, token: string) {
        this.baseUrl = baseUrl;
        this.token = token;}

    private async req<T>(method: string, path: string, body?: unknown, notFoundNull = false): Promise<T> {
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 4; attempt++) {
            try {
                const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
                const init: RequestInit = { method, headers, signal: AbortSignal.timeout(20_000) };
                if (body !== undefined) {
                    headers['Content-Type'] = 'application/json';
                    init.body = JSON.stringify(body);
                }
                const res = await fetch(`${this.baseUrl}/api/v4${path}`, init);
                if (res.status === 404 && notFoundNull) return null as T;
                if (res.status === 429 || res.status >= 500) {
                    const reset = Number(res.headers.get('X-Ratelimit-Reset'));
                    if (res.status === 429 && reset > 0) await sleep(Math.min(reset, 10) * 1000);
                    throw new MattermostError(`Mattermost ${res.status} on ${method} ${path}`, res.status);
                }
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    throw new MattermostError(`Mattermost ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`, res.status);
                }
                return (await res.json()) as T;
            } catch (e) {
                lastErr = e;
                const retryable = !(e instanceof MattermostError) || e.status === 429 || e.status >= 500;
                if (!retryable || attempt === 4) break;
                log.debug('mattermost retry', { path, attempt });
                await sleep(backoffMs(attempt, 400, 6000));
            }
        }
        throw lastErr;
    }

    async me(): Promise<MmUser> {
        this.meCache ??= await this.req<MmUser>('GET', '/users/me');
        return this.meCache;
    }

    createPost = (post: OutPost) => this.req<MmPost>('POST', '/posts', { ...post, message: clamp(post.message) });
    patchPost = (id: string, patch: { message?: string; props?: OutPost['props'] }) =>
        this.req<MmPost>('PUT', `/posts/${id}/patch`, patch.message === undefined ? patch : { ...patch, message: clamp(patch.message) });
    getPost = (id: string) => this.req<MmPost>('GET', `/posts/${id}`);
    async postsSince(channelId: string, sinceMs: number): Promise<MmPost[]> {
        const r = await this.req<{ order: string[]; posts: Record<string, MmPost> }>('GET', `/channels/${channelId}/posts?since=${Math.max(0, Math.floor(sinceMs))}`);
        return Object.values(r.posts ?? {}).sort((a, b) => (a.update_at ?? a.create_at ?? 0) - (b.update_at ?? b.create_at ?? 0));
    }
    deletePost = async (id: string) => {
        await this.req('DELETE', `/posts/${id}`);
    };

    async dmChannel(userId: string): Promise<string> {
        const me = await this.me();
        const ch = await this.req<{ id: string }>('POST', '/channels/direct', [me.id, userId]);
        return ch.id;
    }

    userByEmail = (email: string) => this.req<MmUser | null>('GET', `/users/email/${encodeURIComponent(email)}`, undefined, true);
    userByUsername = (u: string) => this.req<MmUser | null>('GET', `/users/username/${encodeURIComponent(u)}`, undefined, true);
    userById = (id: string) => this.req<MmUser | null>('GET', `/users/${id}`, undefined, true);

    async addReaction(postId: string, emoji: string): Promise<void> {
        const me = await this.me();
        await this.req('POST', '/reactions', { user_id: me.id, post_id: postId, emoji_name: emoji, create_at: 0 });
    }

    async removeReaction(postId: string, emoji: string): Promise<void> {
        const me = await this.me();
        await this.req('DELETE', `/users/${me.id}/posts/${postId}/reactions/${emoji}`);
    }

    async uploadFile(channelId: string, filename: string, content: string): Promise<string> {
        const form = new FormData();
        form.append('channel_id', channelId);
        form.append('files', new Blob([content], { type: 'text/plain' }), filename);
        const res = await fetch(`${this.baseUrl}/api/v4/files`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.token}` },
            body: form,
            signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new MattermostError(`Mattermost ${res.status} uploading file`, res.status);
        const json = (await res.json()) as { file_infos: { id: string }[] };
        const id = json.file_infos[0]?.id;
        if (!id) throw new MattermostError('Upload returned no file id', 500);
        return id;
    }

    async addSelfToTeam(teamId: string): Promise<void> {
        const me = await this.me();
        await this.req('POST', `/teams/${teamId}/members`, { team_id: teamId, user_id: me.id });
    }

    async addSelfToChannel(channelId: string): Promise<void> {
        const me = await this.me();
        await this.req('POST', `/channels/${channelId}/members`, { user_id: me.id });
    }

    async isChannelMember(channelId: string, userId: string): Promise<boolean> {
        const m = await this.req<unknown>('GET', `/channels/${channelId}/members/${userId}`, undefined, true);
        return m !== null;
    }

    getTeamByName = (name: string) => this.req<{ id: string }>('GET', `/teams/name/${encodeURIComponent(name)}`);

    async ensureCommand(teamId: string, trigger: string, url: string): Promise<{ token: string }> {
        const existing = await this.req<{ id: string; trigger: string; token: string; url: string }[]>(
            'GET',
            `/commands?team_id=${teamId}&custom_only=true`,
        );
        const body = {
            team_id: teamId,
            trigger,
            method: 'P',
            url,
            display_name: 'GitLab',
            description: 'GitLab updates: watch pipelines, link accounts, toggle features',
            auto_complete: true,
            auto_complete_desc: 'GitLab helper: watch, status, features, link…',
            auto_complete_hint: '[help|watch|mrs|pipelines|logs|link|me|features|mute|route|digest]',
        };
        const found = existing.find((c) => c.trigger === trigger);
        if (found) {
            const upd = await this.req<{ token: string }>('PUT', `/commands/${found.id}`, { ...body, id: found.id });
            return { token: upd.token };
        }
        const created = await this.req<{ token: string }>('POST', '/commands', body);
        return { token: created.token };
    }

    async ephemeral(userId: string, channelId: string, message: string): Promise<void> {
        await this.req('POST', '/posts/ephemeral', { user_id: userId, post: { channel_id: channelId, message } });
    }
}
