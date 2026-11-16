import type { Db } from '../db/index.ts';
import { nowIso } from '../db/index.ts';
import type { MattermostApi, MmUser } from '../mattermost/types.ts';

export interface UserPrefs {
    dmPipelines?: boolean;
    dmReviews?: boolean;
    dmComments?: boolean;
    dmState?: boolean;
    failuresOnly?: boolean;
    quietHours?: boolean;
    mutedProjects?: string[];
}

export interface LinkedUser {
    gitlab_username: string;
    gitlab_user_id: number | null;
    mm_user_id: string;
    mm_username: string;
    source: 'email' | 'manual';
    prefs: UserPrefs;
}

interface Row extends Omit<LinkedUser, 'prefs'> {
    prefs: string;
}

const hydrate = (r: Row | undefined): LinkedUser | null => (r ? { ...r, prefs: JSON.parse(r.prefs) as UserPrefs } : null);

export class UsersStore {
    private readonly misses = new Map<string, number>();

    private readonly db: Db;
    private readonly mm: MattermostApi;
    constructor(db: Db, mm: MattermostApi) {
        this.db = db;
        this.mm = mm;}

    byGitlab(username: string): LinkedUser | null {
        return hydrate(this.db.prepare('SELECT * FROM users WHERE gitlab_username = ? COLLATE NOCASE').get(username) as Row | undefined);
    }

    byMm(mmUserId: string): LinkedUser | null {
        return hydrate(this.db.prepare('SELECT * FROM users WHERE mm_user_id = ?').get(mmUserId) as Row | undefined);
    }

    all(): LinkedUser[] {
        return (this.db.prepare('SELECT * FROM users ORDER BY gitlab_username').all() as unknown as Row[]).map((r) => hydrate(r)!);
    }

    link(gitlabUsername: string, mm: { id: string; username: string }, source: 'email' | 'manual', gitlabUserId?: number): void {
        this.db
            .prepare(
                `INSERT INTO users (gitlab_username, gitlab_user_id, mm_user_id, mm_username, source, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(gitlab_username) DO UPDATE SET
                    mm_user_id = excluded.mm_user_id, mm_username = excluded.mm_username,
                    source = excluded.source, gitlab_user_id = COALESCE(excluded.gitlab_user_id, gitlab_user_id)`,
            )
            .run(gitlabUsername.toLowerCase(), gitlabUserId ?? null, mm.id, mm.username, source, nowIso());
    }

    unlink(gitlabUsername: string): boolean {
        return this.db.prepare('DELETE FROM users WHERE gitlab_username = ? COLLATE NOCASE').run(gitlabUsername).changes > 0;
    }

    setPrefs(gitlabUsername: string, patch: Partial<UserPrefs>): UserPrefs | null {
        const u = this.byGitlab(gitlabUsername);
        if (!u) return null;
        const next = { ...u.prefs, ...patch };
        this.db.prepare('UPDATE users SET prefs = ? WHERE gitlab_username = ? COLLATE NOCASE').run(JSON.stringify(next), gitlabUsername);
        return next;
    }

    /**
     * Find the Mattermost user for a GitLab person. Order: stored link → e-mail match (any of the given addresses:
     * webhook e-mail, commit author e-mail, GitLab profile e-mail) → identical username. Misses are remembered for
     * 10 minutes. A successful match is stored, so it is only ever computed once.
     */
    async resolve(gitlabUsername: string, emails: (string | null | undefined)[], autoLink: boolean, profileEmail?: () => Promise<string | null | undefined>): Promise<LinkedUser | null> {
        const stored = this.byGitlab(gitlabUsername);
        if (stored) return stored;
        if (!autoLink) return null;
        const missAt = this.misses.get(gitlabUsername.toLowerCase());
        if (missAt && Date.now() - missAt < 10 * 60_000) return null;

        const usable = (e: string | null | undefined): e is string => !!e && !/redacted|noreply|users\.noreply/i.test(e);
        let found: MmUser | null = null;
        for (const e of [...new Set(emails.filter(usable))]) {
            found = await this.mm.userByEmail(e).catch(() => null);
            if (found) break;
        }
        if (!found) found = await this.mm.userByUsername(gitlabUsername.toLowerCase()).catch(() => null);
        if (!found && profileEmail) {
            const e = await profileEmail().catch(() => null);
            if (usable(e)) found = await this.mm.userByEmail(e).catch(() => null);
        }
        if (!found || found.is_bot) {
            if (this.misses.size > 2000) this.misses.clear();
            this.misses.set(gitlabUsername.toLowerCase(), Date.now());
            return null;
        }
        this.link(gitlabUsername, found, 'email');
        return this.byGitlab(gitlabUsername);
    }
}
