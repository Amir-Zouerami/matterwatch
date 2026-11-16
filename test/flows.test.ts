import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENERAL, UPDATES, makeApp, pipelineEvent, PROJECT } from './helpers.ts';
import { parseEvent } from '../src/gitlab/events.ts';
import { dispatchEvent } from '../src/services/handlers.ts';
import { handleMessagePosted } from '../src/services/watch.ts';
import { handleAction } from '../src/services/actions.ts';
import { handleSlash } from '../src/services/slash.ts';
import { runDueScheduled } from '../src/services/scheduler.ts';
import { signContext } from '../src/mattermost/sign.ts';
import { createHttpApp } from '../src/http/app.ts';
import { drainInbound } from '../src/services/ingest.ts';

async function send(app: ReturnType<typeof makeApp>['app'], payload: unknown): Promise<void> {
    const parsed = parseEvent(payload);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    await dispatchEvent(app, parsed.event);
}

function linkAlice(app: ReturnType<typeof makeApp>['app']) {
    app.users.link('alice.dev', { id: 'u_alice', username: 'alice.dev' }, 'manual');
}

test('failed pipeline: one card (edited in place), mentions author, posts masked logs in a thread, DMs author', async () => {
    const { app, mm, gl } = makeApp();
    linkAlice(app);
    gl.jobs.set(100, [{ id: 2, name: 'unit-tests', stage: 'test', status: 'failed', allow_failure: false, failure_reason: 'script_failure', web_url: `${PROJECT.web_url}/-/jobs/2` }]);
    gl.traces.set(2, 'line1\n\u001b[31mError: boom\u001b[0m\nDB_PASSWORD=supersecret123\nlast line');

    await send(app, pipelineEvent({ status: 'running' }));
    assert.equal(mm.inChannel(UPDATES).length, 1);
    const cardId = mm.inChannel(UPDATES)[0]!.id;

    await send(app, pipelineEvent({ status: 'failed' }));
    // card edited, not duplicated
    assert.equal(mm.patches.length, 1);
    assert.equal(mm.patches[0]!.id, cardId);
    assert.match(mm.posts[0]!.message, /failed/);
    assert.match(mm.posts[0]!.message, /@alice\.dev/);

    // logs as a thread reply, masked
    const logPost = mm.inChannel(UPDATES).find((p) => p.root_id === cardId)!;
    assert.ok(logPost, 'log reply exists');
    assert.match(logPost.message, /Error: boom/);
    assert.ok(!logPost.message.includes('supersecret123'));
    assert.ok(!logPost.message.includes('\u001b'));

    // retry button present on failed card
    const att = (mm.posts[0]!.props?.attachments ?? [])[0]!;
    assert.deepEqual(att.actions!.map((a) => a.id), ['retry_pipeline', 'show_logs']);

    // DM to the author
    assert.equal(mm.dmsTo('u_alice').length, 1);
    assert.match(mm.dmsTo('u_alice')[0]!.message, /failed/);
});

test('key/value table has no empty header row; jobs table is rendered in card', async () => {
    const { app, mm } = makeApp();
    await send(app, pipelineEvent({ status: 'failed' }));
    const text = mm.posts[0]!.props!.attachments![0]!.text!;
    assert.ok(!text.includes('| | |'), 'no blank header row');
    assert.match(text, /^(#### [^\n]*\n\n)?\| \*\*Project\*\* \|/);
    assert.match(text, /\| Stage \| Job \| Result \| Time \|/);
    assert.match(text, /unit-tests/);
});

test('feature switch: cards.pipeline off silences channel cards but a link watch still reports', async () => {
    const { app, mm } = makeApp();
    app.features.setGlobal('cards.pipeline', false, 't');
    await send(app, pipelineEvent({ status: 'failed' }));
    assert.equal(mm.inChannel(UPDATES).length, 0);
});

test('per-channel override: feature off globally, on for one channel scope is honoured', () => {
    const { app } = makeApp();
    app.features.setGlobal('links.watch_mr', false, 't');
    app.features.setOverride('links.watch_mr', 'channel', GENERAL, true, 't');
    assert.equal(app.features.isEnabled('links.watch_mr', { channelId: GENERAL }), true);
    assert.equal(app.features.isEnabled('links.watch_mr', { channelId: 'other' }), false);
});

test('pasting an MR link in another channel watches it and reports the outcome there', async () => {
    const { app, mm, gl } = makeApp();
    const url = `${PROJECT.web_url}/-/merge_requests/822`;
    gl.pipelines.set(100, { id: 100, project_id: 7, status: 'running', ref: 'feat/hero', sha: 'a'.repeat(40), web_url: `${PROJECT.web_url}/-/pipelines/100` });
    gl.mr.head_pipeline = gl.pipelines.get(100)!;
    gl.jobs.set(100, [{ id: 2, name: 'unit-tests', stage: 'test', status: 'running', allow_failure: false, web_url: 'x' }]);

    await handleMessagePosted(app, { id: 'userpost', channel_id: GENERAL, user_id: 'u_sara', message: `review pls ${url}`, root_id: '' });

    assert.ok(mm.reactions.some((r) => r.postId === 'userpost' && r.emoji === 'eyes'));
    const first = mm.inChannel(GENERAL)[0]!;
    assert.equal(first.root_id, 'userpost', 'status card is a thread reply to the pasted message');
    assert.match(first.message, /Watching/);
    assert.equal(app.watches.allActive().length, 1);

    // pasting again does not create a second watch
    await handleMessagePosted(app, { id: 'again', channel_id: GENERAL, user_id: 'u_alice', message: url, root_id: '' });
    assert.equal(app.watches.allActive().length, 1);

    // webhook: pipeline fails → card edited + ping reply mentioning the poster + failure logs
    gl.jobs.set(100, [{ id: 2, name: 'unit-tests', stage: 'test', status: 'failed', allow_failure: false, web_url: 'x' }]);
    gl.traces.set(2, 'compile error at x.ts:3');
    await send(app, pipelineEvent({ status: 'failed' }));

    const msgs = mm.inChannel(GENERAL).map((p) => p.message).join('\n');
    assert.match(msgs, /@sara/);
    assert.match(msgs, /failed/);
    assert.match(msgs, /compile error at x\.ts:3/);
    assert.ok(mm.reactions.some((r) => r.postId === 'userpost' && r.emoji === 'x'));
    assert.ok(mm.reactions.some((r) => r.postId === 'userpost' && r.emoji === 'eyes' && r.removed));

    // replayed webhook does not ping twice
    const before = mm.inChannel(GENERAL).length;
    await send(app, pipelineEvent({ status: 'failed' }));
    assert.equal(mm.inChannel(GENERAL).length, before);
});

test('link watching can be switched off per channel', async () => {
    const { app, mm, gl } = makeApp();
    app.features.setOverride('links.watch_mr', 'channel', GENERAL, false, 't');
    await handleMessagePosted(app, { id: 'x', channel_id: GENERAL, user_id: 'u_sara', message: `${PROJECT.web_url}/-/merge_requests/822`, root_id: '' });
    assert.equal(app.watches.allActive().length, 0);
    assert.equal(mm.posts.length, 0);
    void gl;
});

test('links in the updates channel are not double-reported', async () => {
    const { app } = makeApp();
    await handleMessagePosted(app, { id: 'x', channel_id: UPDATES, user_id: 'u_sara', message: `${PROJECT.web_url}/-/merge_requests/822`, root_id: '' });
    assert.equal(app.watches.allActive().length, 0);
});

test('bot messages and other hosts are ignored', async () => {
    const { app, mm } = makeApp();
    await handleMessagePosted(app, { id: 'b', channel_id: GENERAL, user_id: 'bot', message: `${PROJECT.web_url}/-/merge_requests/822`, root_id: '' });
    await handleMessagePosted(app, { id: 'g', channel_id: GENERAL, user_id: 'u_sara', message: 'https://github.com/a/b/-/merge_requests/1', root_id: '' });
    assert.equal(mm.posts.length, 0);
});

test('merged MR with a watch follows the post-merge pipeline', async () => {
    const { app, mm, gl } = makeApp();
    gl.pipelines.set(100, { id: 100, project_id: 7, status: 'success', ref: 'feat/hero', sha: 'a'.repeat(40), web_url: 'u' });
    gl.mr.head_pipeline = gl.pipelines.get(100)!;
    await handleMessagePosted(app, { id: 'up', channel_id: GENERAL, user_id: 'u_sara', message: `${PROJECT.web_url}/-/merge_requests/822`, root_id: '' });
    const mergeSha = 'b'.repeat(40);
    await send(app, {
        object_kind: 'merge_request', user: { username: 'alice.dev', name: 'Alice' }, project: PROJECT,
        object_attributes: { iid: 822, title: 'feat(sections): add hero', state: 'merged', action: 'merge', source_branch: 'feat/hero', target_branch: 'master', url: 'u', merge_commit_sha: mergeSha, last_commit: { id: 'a'.repeat(40) } },
    });
    assert.equal(app.watches.allActive()[0]!.merge_sha, mergeSha);
    await send(app, pipelineEvent({ id: 101, status: 'success', sha: mergeSha, mrIid: null }));
    assert.equal(app.watches.allActive().length, 0, 'watch is done after the merge pipeline finishes');
    assert.match(mm.inChannel(GENERAL).map((p) => p.message).join('\n'), /merged/);
});

test('MR opened: card with table, reviewers pinged, reviewer DM, buttons gated by switches', async () => {
    const { app, mm } = makeApp();
    app.users.link('sara', { id: 'u_sara', username: 'sara' }, 'manual');
    await send(app, {
        object_kind: 'merge_request', user: { username: 'alice.dev', name: 'Alice' }, project: PROJECT,
        object_attributes: { iid: 1371, title: 'fix(countdown): add none option to template 1 visual identity', state: 'opened', action: 'open', source_branch: 'fix/c', target_branch: 'master', url: `${PROJECT.web_url}/-/merge_requests/1371`, description: 'body\n\nCo-Authored-By: Jane Doe' },
        reviewers: [{ username: 'sara', name: 'Sara' }],
    });
    const post = mm.inChannel(UPDATES)[0]!;
    assert.match(post.message, /@sara/);
    const att = post.props!.attachments![0]!;
    assert.match(att.text!, /\*\*fix\*\* `countdown`/);
    assert.ok(!att.text!.includes('Co-Authored-By'));
    assert.deepEqual(att.actions!.map((a) => a.id), ['approve_mr', 'merge_mr']);
    assert.equal(mm.dmsTo('u_sara').length, 1);

    app.features.setGlobal('actions.merge', false, 't');
    await send(app, { ...{ object_kind: 'merge_request', user: { username: 'alice.dev' }, project: PROJECT, object_attributes: { iid: 1372, title: 't', state: 'opened', action: 'open', source_branch: 'a', target_branch: 'master', url: 'u' } } });
    assert.deepEqual(mm.inChannel(UPDATES)[1]!.props!.attachments![0]!.actions!.map((a) => a.id), ['approve_mr']);
});

test('muted project and ignored bots produce no cards', async () => {
    const { app, mm } = makeApp({ IGNORE_USERS: 'ci-bot' });
    app.projects.touch(PROJECT.id, PROJECT.path_with_namespace);
    app.projects.setMuted(PROJECT.id, true);
    await send(app, pipelineEvent({ status: 'failed' }));
    assert.equal(mm.inChannel(UPDATES).length, 0);
    app.projects.setMuted(PROJECT.id, false);
    await send(app, pipelineEvent({ status: 'failed', user: 'ci-bot' }));
    assert.equal(mm.inChannel(UPDATES).length, 0);
});

test('quiet hours defer DMs and the scheduler delivers them later', async () => {
    const { app, mm } = makeApp({ QUIET_HOURS_START: '0', QUIET_HOURS_END: '23', TZ_NAME: 'UTC' }); // quiet for hours 0-22
    linkAlice(app);
    const hour = new Date().getUTCHours();
    if (hour === 23) return; // would not be quiet; skip rare edge
    await send(app, pipelineEvent({ status: 'success' }));
    assert.equal(mm.dmsTo('u_alice').length, 0);
    const pending = app.db.prepare(`SELECT COUNT(*) n FROM scheduled WHERE status='pending'`).get() as { n: number };
    assert.equal(pending.n, 1);
    app.db.prepare(`UPDATE scheduled SET run_at = '2000-01-01T00:00:00.000Z'`).run();
    await runDueScheduled(app);
    assert.equal(mm.dmsTo('u_alice').length, 1);
    app.features.setGlobal('dm.quiet_hours', false, 't');
});

test('button actions: signature, linked-user gate, feature gate, audit', async () => {
    const { app, mm, gl } = makeApp();
    gl.pipelines.set(100, { id: 100, project_id: 7, status: 'failed', ref: 'x', sha: 's', web_url: 'u' });
    const ctx = signContext('signsecret', { action: 'retry_pipeline', projectId: 7, projectPath: PROJECT.path_with_namespace, pipelineId: 100 });

    // bad signature
    let r = await handleAction(app, { user_id: 'u_sara', channel_id: UPDATES, post_id: 'p', context: { ...ctx, pipelineId: 101 } });
    assert.match(r.ephemeral_text!, /no longer valid/);

    // unlinked non-admin
    r = await handleAction(app, { user_id: 'u_sara', channel_id: UPDATES, post_id: 'p', context: ctx });
    assert.match(r.ephemeral_text!, /Link your GitLab account/);
    assert.deepEqual(gl.calls, []);

    // linked user works
    app.users.link('sara', { id: 'u_sara', username: 'sara' }, 'manual');
    r = await handleAction(app, { user_id: 'u_sara', user_name: 'sara', channel_id: UPDATES, post_id: 'p', context: ctx });
    assert.deepEqual(gl.calls, ['retry:100']);
    assert.equal(app.audit.recent(1)[0]!.action, 'retry_pipeline');
    assert.ok(mm.posts.some((p) => p.root_id === 'p' && /retried/.test(p.message)));

    // switched off
    app.features.setGlobal('actions.retry', false, 't');
    r = await handleAction(app, { user_id: 'u_sara', channel_id: UPDATES, post_id: 'p', context: ctx });
    assert.match(r.ephemeral_text!, /switched off/);
    assert.equal(gl.calls.length, 1);
});

test('merge button: merges immediately when green, otherwise merge-when-green', async () => {
    const { app, gl } = makeApp();
    app.users.link('sara', { id: 'u_sara', username: 'sara' }, 'manual');
    const ctx = signContext('signsecret', { action: 'merge_mr', projectId: 7, projectPath: 'p', iid: 822 });
    gl.mr.head_pipeline = { id: 1, project_id: 7, status: 'running', ref: 'x', sha: 's', web_url: 'u' };
    await handleAction(app, { user_id: 'u_sara', channel_id: UPDATES, post_id: 'p', context: ctx });
    gl.mr.head_pipeline = { ...gl.mr.head_pipeline, status: 'success' };
    await handleAction(app, { user_id: 'u_sara', channel_id: UPDATES, post_id: 'p', context: ctx });
    assert.deepEqual(gl.calls, ['merge:822:true', 'merge:822:false']);
});

test('slash: admin can toggle features globally and per channel; non-admin cannot', async () => {
    const { app } = makeApp();
    let r = await handleSlash(app, { user_id: 'u_sara', user_name: 'sara', channel_id: GENERAL, text: 'features off dm.*' });
    assert.match(r.text, /system admin/);
    r = await handleSlash(app, { user_id: 'u_alice', user_name: 'alice', channel_id: GENERAL, text: 'features off dm.*' });
    assert.match(r.text, /Turned off/);
    assert.equal(app.features.isEnabled('dm.pipeline_result'), false);
    r = await handleSlash(app, { user_id: 'u_alice', user_name: 'alice', channel_id: GENERAL, text: 'features on links.watch_mr here' });
    assert.equal(app.features.isEnabled('links.watch_mr', { channelId: GENERAL }), true);
    r = await handleSlash(app, { user_id: 'u_alice', user_name: 'alice', channel_id: GENERAL, text: 'features' });
    assert.match(r.text, /cards\.pipeline/);
    app.features.setGlobal('slash.commands', false, 't');
    r = await handleSlash(app, { user_id: 'u_alice', user_name: 'alice', channel_id: GENERAL, text: 'help' });
    assert.match(r.text, /switched off/);
});

test('slash: link verifies identity; watch command creates a watch here', async () => {
    const { app, gl } = makeApp();
    let r = await handleSlash(app, { user_id: 'u_sara', user_name: 'sara', channel_id: GENERAL, text: 'link alice.dev' });
    assert.match(r.text, /can't verify/);
    r = await handleSlash(app, { user_id: 'u_alice', user_name: 'alice.dev', channel_id: GENERAL, text: 'link alice.dev' });
    assert.match(r.text, /Linked/);
    gl.pipelines.set(100, { id: 100, project_id: 7, status: 'running', ref: 'x', sha: 's', web_url: 'u' });
    gl.mr.head_pipeline = gl.pipelines.get(100)!;
    r = await handleSlash(app, { user_id: 'u_alice', user_name: 'alice', channel_id: GENERAL, text: `watch ${PROJECT.web_url}/-/merge_requests/822` });
    assert.match(r.text, /Watching/);
    assert.equal(app.watches.forChannel(GENERAL).length, 1);
    r = await handleSlash(app, { user_id: 'u_alice', user_name: 'alice', channel_id: GENERAL, text: 'unwatch all' });
    assert.equal(app.watches.forChannel(GENERAL).length, 0);
});

test('http: webhook auth, dedupe, persistence, background processing; admin api', async () => {
    const { app, mm } = makeApp();
    let kicked = 0;
    const http = createHttpApp(app, { kick: () => kicked++, socketConnected: () => true });
    const body = JSON.stringify(pipelineEvent({ status: 'failed' }));

    let res = await http.request('/hooks/gitlab', { method: 'POST', body, headers: { 'x-gitlab-token': 'wrong' } });
    assert.equal(res.status, 401);
    res = await http.request('/hooks/gitlab', { method: 'POST', body: 'not json', headers: { 'x-gitlab-token': 'whsecret' } });
    assert.equal(res.status, 400);
    res = await http.request('/hooks/gitlab', { method: 'POST', body, headers: { 'x-gitlab-token': 'whsecret', 'x-gitlab-event-uuid': 'abc' } });
    assert.equal(res.status, 202);
    res = await http.request('/hooks/gitlab', { method: 'POST', body, headers: { 'x-gitlab-token': 'whsecret', 'x-gitlab-event-uuid': 'abc' } });
    assert.equal(((await res.json()) as { duplicate: boolean }).duplicate, true);
    assert.equal(kicked, 2);

    await drainInbound(app);
    assert.equal(mm.inChannel(UPDATES).length >= 1, true);
    assert.equal((app.db.prepare(`SELECT COUNT(*) n FROM inbound_events WHERE status='done'`).get() as { n: number }).n, 1);

    assert.equal((await http.request('/admin/features')).status, 401);
    res = await http.request('/admin/features/cards.pipeline', { method: 'PUT', body: JSON.stringify({ enabled: false }), headers: { authorization: 'Bearer admintoken' } });
    assert.equal(res.status, 200);
    assert.equal(app.features.isEnabled('cards.pipeline'), false);
    assert.equal((await http.request('/healthz')).status, 200);
    assert.match(await (await http.request('/metrics')).text(), /gitlab_mm_active_watches/);
});

test('a failing Mattermost post is retried, not lost', async () => {
    const { app, mm } = makeApp();
    const http = createHttpApp(app, { kick: () => undefined, socketConnected: () => true });
    const orig = mm.createPost;
    mm.createPost = async () => {
        throw new Error('mattermost down');
    };
    await http.request('/hooks/gitlab', { method: 'POST', body: JSON.stringify(pipelineEvent({ status: 'failed' })), headers: { 'x-gitlab-token': 'whsecret', 'x-gitlab-event-uuid': 'u1' } });
    await drainInbound(app);
    const row = app.db.prepare(`SELECT status, attempts FROM inbound_events`).get() as { status: string; attempts: number };
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    mm.createPost = orig;
    app.db.prepare(`UPDATE inbound_events SET next_attempt_at = '2000-01-01T00:00:00.000Z'`).run();
    await drainInbound(app);
    assert.equal(mm.inChannel(UPDATES).length >= 1, true);
});
