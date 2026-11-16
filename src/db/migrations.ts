import type { DatabaseSync } from 'node:sqlite';

/** Append-only. Never edit a shipped migration; add a new one. */
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
    {
        id: 1,
        name: 'initial',
        sql: `
        CREATE TABLE features (
            key        TEXT PRIMARY KEY,
            enabled    INTEGER NOT NULL,
            updated_by TEXT,
            updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE feature_overrides (
            key        TEXT NOT NULL,
            scope_type TEXT NOT NULL CHECK (scope_type IN ('channel','user','project')),
            scope_id   TEXT NOT NULL,
            enabled    INTEGER NOT NULL,
            updated_by TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (key, scope_type, scope_id)
        ) STRICT;

        CREATE TABLE settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE users (
            gitlab_username TEXT PRIMARY KEY,
            gitlab_user_id  INTEGER,
            mm_user_id      TEXT NOT NULL,
            mm_username     TEXT NOT NULL,
            source          TEXT NOT NULL CHECK (source IN ('email','manual')),
            prefs           TEXT NOT NULL DEFAULT '{}',
            created_at      TEXT NOT NULL
        ) STRICT;
        CREATE INDEX users_mm ON users(mm_user_id);

        CREATE TABLE inbound_events (
            id              INTEGER PRIMARY KEY,
            delivery_key    TEXT NOT NULL UNIQUE,
            event_type      TEXT NOT NULL,
            project_path    TEXT,
            payload         TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','dead')),
            attempts        INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TEXT NOT NULL,
            error           TEXT,
            received_at     TEXT NOT NULL,
            processed_at    TEXT
        ) STRICT;
        CREATE INDEX inbound_pending ON inbound_events(status, next_attempt_at);

        CREATE TABLE cards (
            id         INTEGER PRIMARY KEY,
            kind       TEXT NOT NULL,
            project_id INTEGER NOT NULL,
            ref        TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            post_id    TEXT NOT NULL,
            state      TEXT,
            updated_at TEXT NOT NULL,
            UNIQUE (kind, project_id, ref, channel_id)
        ) STRICT;
        CREATE INDEX cards_post ON cards(post_id);

        CREATE TABLE watches (
            id                    INTEGER PRIMARY KEY,
            project_id            INTEGER NOT NULL,
            project_path          TEXT NOT NULL,
            kind                  TEXT NOT NULL CHECK (kind IN ('mr','pipeline')),
            ref                   TEXT NOT NULL,
            channel_id            TEXT NOT NULL,
            root_post_id          TEXT,
            card_post_id          TEXT,
            requested_by_mm       TEXT,
            status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','stopped','expired')),
            last_pipeline_id      INTEGER,
            last_notified_pipeline INTEGER,
            merge_sha             TEXT,
            created_at            TEXT NOT NULL,
            updated_at            TEXT NOT NULL,
            expires_at            TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX watches_unique_active
            ON watches(project_id, kind, ref, channel_id) WHERE status = 'active';
        CREATE INDEX watches_lookup ON watches(project_id, kind, ref, status);

        CREATE TABLE scheduled (
            id         INTEGER PRIMARY KEY,
            kind       TEXT NOT NULL,
            payload    TEXT NOT NULL,
            run_at     TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','dead')),
            attempts   INTEGER NOT NULL DEFAULT 0,
            error      TEXT,
            created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX scheduled_due ON scheduled(status, run_at);

        CREATE TABLE audit_log (
            id          INTEGER PRIMARY KEY,
            ts          TEXT NOT NULL,
            actor_mm    TEXT,
            actor_gl    TEXT,
            action      TEXT NOT NULL,
            target      TEXT,
            result      TEXT NOT NULL
        ) STRICT;

        CREATE TABLE projects (
            project_id INTEGER PRIMARY KEY,
            path       TEXT NOT NULL,
            muted      INTEGER NOT NULL DEFAULT 0,
            channel_id TEXT,
            updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE once (
            key TEXT PRIMARY KEY,
            at  TEXT NOT NULL
        ) STRICT;
        `,
    },
    {
        id: 2,
        name: 'outbox-dedupe-and-card-seq',
        sql: `
        -- exactly-once enqueue of side effects (DMs, thread pings, failure logs) per originating event
        ALTER TABLE scheduled ADD COLUMN dedupe_key TEXT;
        CREATE UNIQUE INDEX scheduled_dedupe ON scheduled(dedupe_key) WHERE dedupe_key IS NOT NULL;
        -- inbox sequence of the event that last wrote a card: stale (older) retried events must not overwrite it
        ALTER TABLE cards ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
        `,
    },
];

export function migrate(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    ) STRICT`);
    const done = new Set(
        (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
    );
    for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        db.exec('BEGIN IMMEDIATE');
        try {
            db.exec(m.sql);
            db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
                m.id,
                m.name,
                new Date().toISOString(),
            );
            db.exec('COMMIT');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }
}
