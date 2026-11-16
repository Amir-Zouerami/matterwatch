// Boots the REAL process (src/index.ts) against stub Mattermost + GitLab HTTP servers and drives it over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const body = (req: IncomingMessage) => new Promise<string>((res) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => res(s)); });
const listen = (srv: Server) => new Promise<number>((res) => srv.listen(0, '127.0.0.1', () => res((srv.address() as { port: number }).port)));
const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };

test('end to end: a real GitLab webhook becomes a Mattermost card; bad secrets are refused', async () => {
    const posts: Record<string, unknown>[] = [];
    const mm = createServer(async (req, res) => {
        const url = req.url ?? '';
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && url.endsWith('/posts')) { const p = JSON.parse(await body(req)); posts.push(p); return res.end(JSON.stringify({ id: `post${posts.length}`, ...p })); }
        if (url.endsWith('/users/me')) return res.end(JSON.stringify({ id: 'bot', username: 'gitlab', roles: 'system_user system_admin', is_bot: true }));
        res.end('{}');
    });
    const gl = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(req.url?.includes('merge_requests') && req.url.includes('commits') ? '[]' : '{}'); });
    const mmPort = await listen(mm);
    const glPort = await listen(gl);
    const dir = mkdtempSync(join(tmpdir(), 'matterwatch-e2e-'));
    const port = 39000 + Math.floor(Math.random() * 500);
    let child: ChildProcess | undefined;
    try {
        child = spawn('node', ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
            env: {
                PATH: process.env['PATH'], PORT: String(port), DB_PATH: join(dir, 'e2e.sqlite'), LOG_LEVEL: 'warn',
                MM_URL: `http://127.0.0.1:${mmPort}`, MM_TOKEN: 'mmtok', MM_TEAM_NAME: 'team', MM_UPDATES_CHANNEL_ID: 'chan1',
                GITLAB_URL: `http://127.0.0.1:${glPort}`, GITLAB_TOKEN: 'gltok', GITLAB_WEBHOOK_SECRET: 'hooksecret', SERVICE_URL: `http://127.0.0.1:${port}`,
                ENABLE_SOCKET: 'false', ENABLE_SETUP: 'false', ENABLE_POLLER: 'false',
            },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        const base = `http://127.0.0.1:${port}`;
        for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
        assert.equal((await fetch(`${base}/healthz`)).status, 200);

        const event = { object_kind: 'merge_request', user: { username: 'alice', name: 'Alice' },
            project: { id: 7, name: 'shop', path_with_namespace: 'acme/shop', web_url: `http://127.0.0.1:${glPort}/acme/shop`, default_branch: 'main' },
            object_attributes: { iid: 12, title: 'feat: hero', state: 'opened', action: 'open', url: `http://127.0.0.1:${glPort}/acme/shop/-/merge_requests/12`, source_branch: 'feat/hero', target_branch: 'main', created_at: '2026-01-01 10:00:00 UTC', updated_at: '2026-01-01 10:00:00 UTC' } };
        const bad = await fetch(`${base}/hooks/gitlab`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gitlab-token': 'nope', 'x-gitlab-event': 'Merge Request Hook' }, body: JSON.stringify(event) });
        assert.equal(bad.status, 401);
        assert.equal(posts.length, 0);

        const ok = await fetch(`${base}/hooks/gitlab`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gitlab-token': 'hooksecret', 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'e2e-1' }, body: JSON.stringify(event) });
        assert.equal(ok.status, 202);
        await until(() => posts.length > 0);
        const card = posts[0] as { channel_id: string; message: string; props?: unknown };
        assert.equal(card.channel_id, 'chan1');
        assert.match(JSON.stringify(card), /feat: hero/);

        // the same delivery again must not post a second card
        await fetch(`${base}/hooks/gitlab`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gitlab-token': 'hooksecret', 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'e2e-1' }, body: JSON.stringify(event) });
        await new Promise((r) => setTimeout(r, 800));
        assert.equal(posts.length, 1);

        // admin and metrics are closed without their tokens
        assert.notEqual((await fetch(`${base}/admin/status`)).status, 200);
    } finally {
        child?.kill();
        mm.close(); gl.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
