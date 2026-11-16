import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, tx } from '../src/db/index.ts';
import { Features } from '../src/features/service.ts';
import { FEATURES } from '../src/features/registry.ts';

test('db opens in WAL mode with foreign keys and migrations applied', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'glmm-')), 'x.sqlite');
    const db = openDb(path);
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get());
    openDb(path); // re-open is idempotent
});

test('tx rolls back on error', () => {
    const db = openDb(':memory:');
    assert.throws(() =>
        tx(db, () => {
            db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('a','1','x')`).run();
            throw new Error('boom');
        }),
    );
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM settings`).get()?.['n'], 0);
});

test('features: defaults, global toggle, override precedence', () => {
    const f = new Features(openDb(':memory:'));
    assert.equal(f.isEnabled('cards.pipeline'), true);
    assert.equal(f.isEnabled('cards.push'), false);
    f.setGlobal('cards.pipeline', false, 'test');
    assert.equal(f.isEnabled('cards.pipeline'), false);
    f.setOverride('cards.pipeline', 'channel', 'c1', true, 'test');
    assert.equal(f.isEnabled('cards.pipeline', { channelId: 'c1' }), true);
    assert.equal(f.isEnabled('cards.pipeline', { channelId: 'c2' }), false);
    f.setOverride('cards.pipeline', 'user', 'u1', false, 'test');
    assert.equal(f.isEnabled('cards.pipeline', { channelId: 'c1', userId: 'u1' }), false);
    f.clearOverride('cards.pipeline', 'channel', 'c1');
    assert.equal(f.isEnabled('cards.pipeline', { channelId: 'c1' }), false);
});

test('features: unknown keys throw, patterns expand', () => {
    const f = new Features(openDb(':memory:'));
    assert.throws(() => f.isEnabled('nope'));
    assert.throws(() => f.setGlobal('nope', true, 'x'));
    assert.ok(f.expand('actions.*').every((k) => k.startsWith('actions.')));
    assert.equal(f.expand('all').length, FEATURES.length);
});
