import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrations.ts';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA wal_autocheckpoint = 1000;
        PRAGMA temp_store = MEMORY;
    `);
    migrate(db);
    return db;
}

/** Run fn inside BEGIN IMMEDIATE ... COMMIT. Rolls back on throw. Not re-entrant. */
export function tx<T>(db: Db, fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (e) {
        try {
            db.exec('ROLLBACK');
        } catch {
            /* connection already rolled back */
        }
        throw e;
    }
}

export const nowIso = (): string => new Date().toISOString();
