import type { Db } from '../db/index.ts';
import { nowIso } from '../db/index.ts';
import { FEATURES, FEATURE_KEYS } from './registry.ts';

export interface FeatureContext {
    channelId?: string | undefined;
    userId?: string | undefined;
    projectId?: number | string | undefined;
}

export type ScopeType = 'channel' | 'user' | 'project';

/**
 * Resolution order (most specific wins): user > channel > project > global > registry default.
 * Reads hit SQLite directly (prepared statements); that is cheap and keeps toggles instant.
 */
export class Features {
    private readonly getGlobal;
    private readonly getOverride;
    private readonly setGlobalStmt;
    private readonly setOverrideStmt;
    private readonly delOverrideStmt;

    private readonly db: Db;
    constructor(db: Db) {
        this.db = db;
        this.getGlobal = db.prepare('SELECT enabled FROM features WHERE key = ?');
        this.getOverride = db.prepare(
            'SELECT enabled FROM feature_overrides WHERE key = ? AND scope_type = ? AND scope_id = ?',
        );
        this.setGlobalStmt = db.prepare(
            `INSERT INTO features (key, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        );
        this.setOverrideStmt = db.prepare(
            `INSERT INTO feature_overrides (key, scope_type, scope_id, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(key, scope_type, scope_id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        );
        this.delOverrideStmt = db.prepare(
            'DELETE FROM feature_overrides WHERE key = ? AND scope_type = ? AND scope_id = ?',
        );
    }

    isEnabled(key: string, ctx: FeatureContext = {}): boolean {
        if (!FEATURE_KEYS.has(key)) throw new Error(`Unknown feature: ${key}`);
        const scopes: [ScopeType, string | undefined][] = [
            ['user', ctx.userId],
            ['channel', ctx.channelId],
            ['project', ctx.projectId === undefined ? undefined : String(ctx.projectId)],
        ];
        for (const [type, id] of scopes) {
            if (!id) continue;
            const row = this.getOverride.get(key, type, id) as { enabled: number } | undefined;
            if (row) return row.enabled === 1;
        }
        const g = this.getGlobal.get(key) as { enabled: number } | undefined;
        if (g) return g.enabled === 1;
        return FEATURES.find((x) => x.key === key)!.default;
    }

    setGlobal(key: string, enabled: boolean, by: string): void {
        this.assertKey(key);
        this.setGlobalStmt.run(key, enabled ? 1 : 0, by, nowIso());
    }

    setOverride(key: string, type: ScopeType, id: string, enabled: boolean, by: string): void {
        this.assertKey(key);
        this.setOverrideStmt.run(key, type, id, enabled ? 1 : 0, by, nowIso());
    }

    /** Back to the registry default. */
    clearGlobal(key: string): void {
        this.assertKey(key);
        this.db.prepare('DELETE FROM features WHERE key = ?').run(key);
    }

    clearOverride(key: string, type: ScopeType, id: string): void {
        this.assertKey(key);
        this.delOverrideStmt.run(key, type, id);
    }

    /** Resolve a pattern like `actions.*`, `dm.*` or `all` to concrete keys. */
    expand(pattern: string): string[] {
        if (pattern === 'all' || pattern === '*') return [...FEATURE_KEYS];
        if (pattern.endsWith('.*')) {
            const prefix = pattern.slice(0, -1);
            return [...FEATURE_KEYS].filter((k) => k.startsWith(prefix));
        }
        return FEATURE_KEYS.has(pattern) ? [pattern] : [];
    }

    snapshot(ctx: FeatureContext = {}): { key: string; group: string; description: string; enabled: boolean; default: boolean }[] {
        return FEATURES.map((x) => ({
            key: x.key,
            group: x.group,
            description: x.description,
            default: x.default,
            enabled: this.isEnabled(x.key, ctx),
        }));
    }

    overrides(): { key: string; scope_type: string; scope_id: string; enabled: number }[] {
        return this.db
            .prepare('SELECT key, scope_type, scope_id, enabled FROM feature_overrides ORDER BY key, scope_type')
            .all() as never;
    }

    private assertKey(key: string): void {
        if (!FEATURE_KEYS.has(key)) throw new Error(`Unknown feature: ${key}`);
    }
}
