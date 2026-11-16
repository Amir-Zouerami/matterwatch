import type { Db } from '../db/index.ts';
import { nowIso, tx } from '../db/index.ts';

export interface Card {
    id: number;
    kind: string;
    project_id: number;
    ref: string;
    channel_id: string;
    post_id: string;
    state: string | null;
    seq: number;
}

export class CardsStore {
    private readonly db: Db;
    constructor(db: Db) {
        this.db = db;}

    get(kind: string, projectId: number, ref: string | number, channelId: string): Card | null {
        return (this.db.prepare('SELECT * FROM cards WHERE kind = ? AND project_id = ? AND ref = ? AND channel_id = ?').get(kind, projectId, String(ref), channelId) as Card | undefined) ?? null;
    }

    byPost(postId: string): Card | null {
        return (this.db.prepare('SELECT * FROM cards WHERE post_id = ?').get(postId) as Card | undefined) ?? null;
    }

    upsert(kind: string, projectId: number, ref: string | number, channelId: string, postId: string, state: string | null, seq = 0): void {
        this.db
            .prepare(
                `INSERT INTO cards (kind, project_id, ref, channel_id, post_id, state, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(kind, project_id, ref, channel_id) DO UPDATE SET post_id = excluded.post_id, state = excluded.state,
                    seq = MAX(cards.seq, excluded.seq), updated_at = excluded.updated_at`,
            )
            .run(kind, projectId, String(ref), channelId, postId, state, seq, nowIso());
    }

    setState(id: number, state: string, seq = 0): void {
        this.db.prepare('UPDATE cards SET state = ?, seq = MAX(seq, ?), updated_at = ? WHERE id = ?').run(state, seq, nowIso(), id);
    }

    prune(olderThanDays: number): number {
        const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
        return Number(this.db.prepare('DELETE FROM cards WHERE updated_at < ?').run(cutoff).changes);
    }
}

export interface Watch {
    id: number;
    project_id: number;
    project_path: string;
    kind: 'mr' | 'pipeline';
    ref: string;
    channel_id: string;
    root_post_id: string | null;
    card_post_id: string | null;
    requested_by_mm: string | null;
    status: 'active' | 'done' | 'stopped' | 'expired';
    last_pipeline_id: number | null;
    last_notified_pipeline: number | null;
    merge_sha: string | null;
    created_at: string;
    updated_at: string;
    expires_at: string;
}

export class WatchesStore {
    private readonly db: Db;
    private readonly ttlHours: number;
    constructor(db: Db, ttlHours: number) {
        this.db = db;
        this.ttlHours = ttlHours;}

    /** Returns the existing active watch (created=false) or a new one. Atomic via the partial unique index. */
    create(input: {
        projectId: number;
        projectPath: string;
        kind: 'mr' | 'pipeline';
        ref: string | number;
        channelId: string;
        rootPostId?: string | null;
        requestedBy?: string | null;
    }): { watch: Watch; created: boolean } {
        return tx(this.db, () => {
            const existing = this.db
                .prepare(`SELECT * FROM watches WHERE project_id = ? AND kind = ? AND ref = ? AND channel_id = ? AND status = 'active'`)
                .get(input.projectId, input.kind, String(input.ref), input.channelId) as Watch | undefined;
            if (existing) return { watch: existing, created: false };
            const now = nowIso();
            const expires = new Date(Date.now() + this.ttlHours * 3_600_000).toISOString();
            const info = this.db
                .prepare(
                    `INSERT INTO watches (project_id, project_path, kind, ref, channel_id, root_post_id, requested_by_mm, created_at, updated_at, expires_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(input.projectId, input.projectPath, input.kind, String(input.ref), input.channelId, input.rootPostId ?? null, input.requestedBy ?? null, now, now, expires);
            const watch = this.db.prepare('SELECT * FROM watches WHERE id = ?').get(Number(info.lastInsertRowid)) as unknown as Watch;
            return { watch, created: true };
        });
    }

    get(id: number): Watch | null {
        return (this.db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Watch | undefined) ?? null;
    }

    activeFor(projectId: number, kind: 'mr' | 'pipeline', ref: string | number): Watch[] {
        return this.db.prepare(`SELECT * FROM watches WHERE project_id = ? AND kind = ? AND ref = ? AND status = 'active'`).all(projectId, kind, String(ref)) as unknown as Watch[];
    }

    activeByMergeSha(projectId: number, sha: string): Watch[] {
        return this.db.prepare(`SELECT * FROM watches WHERE project_id = ? AND merge_sha = ? AND status = 'active'`).all(projectId, sha) as unknown as Watch[];
    }

    allActive(): Watch[] {
        return this.db.prepare(`SELECT * FROM watches WHERE status = 'active' ORDER BY id`).all() as unknown as Watch[];
    }

    forChannel(channelId: string): Watch[] {
        return this.db.prepare(`SELECT * FROM watches WHERE channel_id = ? AND status = 'active' ORDER BY id DESC`).all(channelId) as unknown as Watch[];
    }

    update(id: number, patch: Partial<Pick<Watch, 'card_post_id' | 'last_pipeline_id' | 'last_notified_pipeline' | 'merge_sha' | 'status'>> & { extendTtl?: boolean }): void {
        const sets: string[] = ['updated_at = ?'];
        const vals: (string | number | null)[] = [nowIso()];
        for (const [k, v] of Object.entries(patch)) {
            if (k === 'extendTtl') continue;
            sets.push(`${k} = ?`);
            vals.push(v as string | number | null);
        }
        if (patch.extendTtl) {
            sets.push('expires_at = ?');
            vals.push(new Date(Date.now() + this.ttlHours * 3_600_000).toISOString());
        }
        this.db.prepare(`UPDATE watches SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    }

    stop(id: number): void {
        this.update(id, { status: 'stopped' });
    }

    expireOld(): number {
        return Number(this.db.prepare(`UPDATE watches SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at < ?`).run(nowIso(), nowIso()).changes);
    }
}

export class SettingsStore {
    private readonly db: Db;
    constructor(db: Db) {
        this.db = db;}

    get<T>(key: string, fallback: T): T {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
        return row ? (JSON.parse(row.value) as T) : fallback;
    }

    set(key: string, value: unknown): void {
        this.db
            .prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
            .run(key, JSON.stringify(value), nowIso());
    }
}

export class ProjectsStore {
    private readonly db: Db;
    constructor(db: Db) {
        this.db = db;}

    touch(projectId: number, path: string): void {
        this.db
            .prepare(`INSERT INTO projects (project_id, path, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET path = excluded.path`)
            .run(projectId, path, nowIso());
    }

    get(projectId: number): { project_id: number; path: string; muted: number; channel_id: string | null } | null {
        return (this.db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as never) ?? null;
    }

    byPath(path: string): { project_id: number; path: string; muted: number; channel_id: string | null } | null {
        return (this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as never) ?? null;
    }

    setMuted(projectId: number, muted: boolean): void {
        this.db.prepare('UPDATE projects SET muted = ?, updated_at = ? WHERE project_id = ?').run(muted ? 1 : 0, nowIso(), projectId);
    }

    setChannel(projectId: number, channelId: string | null): void {
        this.db.prepare('UPDATE projects SET channel_id = ?, updated_at = ? WHERE project_id = ?').run(channelId, nowIso(), projectId);
    }

    list(): { project_id: number; path: string; muted: number; channel_id: string | null }[] {
        return this.db.prepare('SELECT * FROM projects ORDER BY path').all() as never;
    }
}

export class AuditStore {
    private readonly db: Db;
    constructor(db: Db) {
        this.db = db;}

    record(entry: { actorMm?: string | null; actorGl?: string | null; action: string; target?: string | null; result: string }): void {
        this.db
            .prepare('INSERT INTO audit_log (ts, actor_mm, actor_gl, action, target, result) VALUES (?, ?, ?, ?, ?, ?)')
            .run(nowIso(), entry.actorMm ?? null, entry.actorGl ?? null, entry.action, entry.target ?? null, entry.result);
    }

    recent(limit = 20): { ts: string; actor_mm: string | null; actor_gl: string | null; action: string; target: string | null; result: string }[] {
        return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as never;
    }
}

/** "Do this at most once" markers (digest days, etc). Returns true when the caller claimed it. */
export class OnceStore {
    private readonly db: Db;
    constructor(db: Db) {
        this.db = db;}

    claim(key: string): boolean {
        return this.db.prepare('INSERT OR IGNORE INTO once (key, at) VALUES (?, ?)').run(key, nowIso()).changes === 1;
    }
}
