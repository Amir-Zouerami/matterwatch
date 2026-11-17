import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENERAL, UPDATES, makeApp, pipelineEvent, PROJECT } from './helpers.ts';
import { parseEvent } from '../src/gitlab/events.ts';
import { dispatchEvent } from '../src/services/handlers.ts';
import { runWithSeq } from '../src/util/context.ts';
import { runDueScheduled } from '../src/services/scheduler.ts';
import { handleSlash } from '../src/services/slash.ts';
import { catchUp, noteSeen } from '../src/services/catchup.ts';
import { readTail } from '../src/gitlab/client.ts';
import { createHttpApp } from '../src/http/app.ts';
import type { MmPost } from '../src/mattermost/types.ts';

type A = ReturnType<typeof makeApp>['app'];
async function send(app: A, payload: unknown, seq?: number): Promise<void> {
    const parsed = parseEvent(payload);
    assert.ok(parsed.ok);
    if (seq === undefined) await dispatchEvent(app, parsed.event);
    else await runWithSeq(seq, () => dispatchEvent(app, parsed.event));
}
const linkAlice = (app: A) => app.users.link('alice.dev', { id: 'u_alice', username: 'alice.dev' }, 'manual');

test('outbox: re-processing the same inbox event never duplicates DMs, pings or logs', async () => {
    const { app, mm, gl } = makeApp();
    linkAlice(app);
    gl.jobs.set(100, [{ id: 2, name: 'unit-tests', stage: 'test', status: 'failed', allow_failure: false, web_url: 'u' }]);
    gl.traces.set(2, 'boom');
    await send(app, pipelineEvent({ status: 'failed' }), 7);
    await send(app, pipelineEvent({ status: 'failed' }), 7); // retried delivery of the same inbox row
    assert.equal(mm.dmsTo('u_alice').length, 1);
    assert.equal(mm.inChannel(UPDATES).filter((p) => /Failed job/.test(p.message)).length, 1);
});

test('outbox: a DM that cannot be delivered is retried, not lost', async () => {
    const { app, mm } = makeApp();
    linkAlice(app);
    const orig = mm.dmChannel;
    mm.dmChannel = async () => {
        throw new Error('mattermost hiccup');
    };
    await send(app, pipelineEvent({ status: 'success' }), 1);
    assert.equal(mm.dmsTo('u_alice').length, 0);
    const row = app.db.prepare(`SELECT status, attempts FROM scheduled WHERE kind='dm'`).get() as { status: string; attempts: number };
    assert.deepEqual({ ...row }, { status: 'pending', attempts: 1 });
    mm.dmChannel = orig;
    app.db.prepare(`UPDATE scheduled SET run_at = '2000-01-01T00:00:00.000Z'`).run();
    await runDueScheduled(app);
    assert.equal(mm.dmsTo('u_alice').length, 1);
});

test('outbox: failure logs survive a GitLab outage and are posted once it recovers', async () => {
    const { app, mm, gl } = makeApp();
    gl.traces.set(2, 'compile error');
    const list = gl.listPipelineJobs;
    gl.listPipelineJobs = async () => {
        throw new Error('gitlab 502');
    };
    await send(app, pipelineEvent({ status: 'failed' }), 3);
    assert.equal(mm.inChannel(UPDATES).filter((p) => /Failed job/.test(p.message)).length, 0);
    gl.listPipelineJobs = list;
    gl.jobs.set(100, [{ id: 2, name: 'unit-tests', stage: 'test', status: 'failed', allow_failure: false, web_url: 'u' }]);
    app.db.prepare(`UPDATE scheduled SET run_at = '2000-01-01T00:00:00.000Z'`).run();
    await runDueScheduled(app);
    assert.match(mm.inChannel(UPDATES).map((p) => p.message).join('\n'), /compile error/);
});

test('stale guard: an older retried event cannot move a card backwards', async () => {
    const { app, mm } = makeApp();
    await send(app, pipelineEvent({ status: 'success' }), 20);
    await send(app, pipelineEvent({ status: 'running' }), 10); // delivered late
    const card = mm.posts.find((p) => /Pipeline/.test(p.message) && p.channel_id === UPDATES)!;
    assert.match(card.message, /passed/);
    await send(app, pipelineEvent({ status: 'running' }), 30); // a genuinely newer state (pipeline retried) still wins
    assert.match(card.message, /running/);
});

test('MR card follows its pipeline (status line + merge button)', async () => {
    const { app, mm, gl } = makeApp();
    await send(app, {
        object_kind: 'merge_request', user: { username: 'alice.dev', name: 'Alice' }, project: PROJECT,
        object_attributes: { iid: 822, title: 'feat(x): y', state: 'opened', action: 'open', source_branch: 'a', target_branch: 'master', url: `${PROJECT.web_url}/-/merge_requests/822` },
    }, 1);
    const card = mm.posts[0]!;
    assert.doesNotMatch(card.props!.attachments![0]!.text!, /passed/);
    await send(app, pipelineEvent({ status: 'success', mrIid: 822 }), 2);
    assert.match(card.props!.attachments![0]!.text!, /#100 passed/);
    void gl;
});

test('untrusted @mentions in comments and titles are defanged (no @channel pings)', async () => {
    const { app, mm } = makeApp();
    app.features.setGlobal('cards.comment', true, 't');
    await send(app, {
        object_kind: 'note', user: { username: 'eve', name: '@here Eve' }, project: PROJECT,
        object_attributes: { id: 1, note: '@channel please look @sara', noteable_type: 'MergeRequest', url: 'u' },
        merge_request: { iid: 5, title: '@all title' },
    });
    const msg = mm.inChannel(UPDATES)[0]!.message;
    assert.ok(!/@(channel|all|here|sara)/.test(msg), msg);
});

test('slash: admins can always re-enable features after switching everything off; global reset restores the default', async () => {
    const { app } = makeApp();
    await handleSlash(app, { user_id: 'u_alice', user_name: 'alice', channel_id: GENERAL, text: 'features off all' });
    assert.equal(app.features.isEnabled('slash.commands'), false);
    assert.match((await handleSlash(app, { user_id: 'u_sara', user_name: 'sara', channel_id: GENERAL, text: 'help' })).text, /switched off/);
    const r = await handleSlash(app, { user_id: 'u_alice', user_name: 'alice', channel_id: GENERAL, text: 'features on all' });
    assert.match(r.text, /Turned on/);
    app.features.setGlobal('cards.push', true, 't');
    await handleSlash(app, { user_id: 'u_alice', user_name: 'alice', channel_id: GENERAL, text: 'features reset cards.push' });
    assert.equal(app.features.isEnabled('cards.push'), false, 'back to the registry default');
});

test('catch-up: links posted while the websocket was down are picked up after reconnect; first run never back-fills', async () => {
    const { app, mm, gl } = makeApp();
    gl.pipelines.set(100, { id: 100, project_id: 7, status: 'running', ref: 'x', sha: 's', web_url: 'u' });
    gl.mr.head_pipeline = gl.pipelines.get(100)!;
    const missed: MmPost = { id: 'old', channel_id: GENERAL, user_id: 'u_sara', message: `${PROJECT.web_url}/-/merge_requests/822`, root_id: '', create_at: Date.now() + 1000, update_at: Date.now() + 1000 };
    mm.missed = [missed];
    await catchUp(app);
    assert.equal(app.watches.allActive().length, 0, 'first run only records the cursor');
    app.settings.set(`lastPost:${GENERAL}`, Date.now() - 60_000);
    await catchUp(app);
    assert.equal(app.watches.allActive().length, 1);
    assert.equal(app.settings.get<number>(`lastPost:${GENERAL}`, 0), missed.update_at);
    noteSeen(app, { ...missed, update_at: missed.update_at! + 5 });
    assert.equal(app.settings.get<number>(`lastPost:${GENERAL}`, 0), missed.update_at! + 5);
});

test('job trace reader keeps only the tail of a huge body', async () => {
    const big = 'x'.repeat(3_000_000) + 'THE-END';
    const out = await readTail(new Response(big), 1000);
    assert.equal(out.length, 1000);
    assert.ok(out.endsWith('THE-END'));
});

test('admin can requeue dead inbox/outbox rows', async () => {
    const { app } = makeApp();
    app.db.prepare(`INSERT INTO inbound_events (delivery_key, event_type, payload, status, attempts, next_attempt_at, received_at) VALUES ('k','pipeline','{}','dead',20,'x','x')`).run();
    app.db.prepare(`INSERT INTO scheduled (kind, payload, run_at, status, attempts, created_at) VALUES ('dm','{}','x','dead',12,'x')`).run();
    const http = createHttpApp(app, { kick: () => undefined, socketConnected: () => true });
    const res = await http.request('/admin/requeue', { method: 'POST', headers: { authorization: 'Bearer admintoken' } });
    assert.deepEqual(await res.json(), { ok: true, inbound: 1, outbox: 1 });
    assert.equal((app.db.prepare(`SELECT COUNT(*) n FROM inbound_events WHERE status='pending'`).get() as { n: number }).n, 1);
});

test('merge: no "Merge" button on the post-merge pipeline card, merged note is posted exactly once even when two paths race, result reactions are swapped', async () => {
    const { app, mm, gl } = makeApp();
    gl.pipelines.set(100, { id: 100, project_id: 7, status: 'success', ref: 'feat/hero', sha: 'a'.repeat(40), web_url: 'u' });
    gl.mr.head_pipeline = gl.pipelines.get(100)!;
    const { handleMessagePosted, onMrMerged, pollWatches } = await import('../src/services/watch.ts');
    await handleMessagePosted(app, { id: 'up', channel_id: GENERAL, user_id: 'u_sara', message: `${PROJECT.web_url}/-/merge_requests/822`, root_id: '' });
    assert.ok(mm.reactions.some((r) => r.postId === 'up' && r.emoji === 'white_check_mark'));
    const sha = 'b'.repeat(40);
    gl.mr.state = 'merged';
    // webhook path and poller path hit at the same moment
    await Promise.all([onMrMerged(app, 7, 822, sha), onMrMerged(app, 7, 822, sha), pollWatches(app)]);
    assert.equal(mm.inChannel(GENERAL).filter((p) => /was \*\*merged\*\*/.test(p.message)).length, 1);
    // the merge pipeline fails: the earlier ✅ is replaced by ❌, 🟣 stays
    gl.mr.state = 'opened'; // a stale cached lookup must not bring the button back
    gl.jobs.set(101, [{ id: 9, name: 'deploy', stage: 'deploy', status: 'failed', allow_failure: false, web_url: 'u' }]);
    await send2(app, pipelineEvent({ id: 101, status: 'failed', sha, mrIid: null }));
    assert.ok(mm.reactions.some((r) => r.postId === 'up' && r.emoji === 'x'));
    assert.ok(mm.reactions.some((r) => r.postId === 'up' && r.emoji === 'white_check_mark' && r.removed));
    // and success on a merged MR never offers "Merge"
    const { dispatchEvent: d2 } = await import('../src/services/handlers.ts');
    const ok = parseEvent(pipelineEvent({ id: 102, status: 'success', mrIid: 822 }));
    assert.ok(ok.ok);
    (ok.event as { merge_request: { state: string } }).merge_request.state = 'merged';
    await d2(app, ok.event);
    const cards = mm.posts.filter((p) => p.channel_id === UPDATES && /#102/.test(p.message));
    assert.ok(cards.length >= 1);
    for (const c of cards) assert.ok(!(c.props?.attachments?.[0]?.actions ?? []).some((a) => a.id === 'merge_mr'));
});

async function send2(app: A, payload: unknown): Promise<void> {
    const parsed = parseEvent(payload);
    assert.ok(parsed.ok);
    await dispatchEvent(app, parsed.event);
}

test('channel records are independent of watches: a watch failure never blocks the dedicated channel card', async () => {
    const { app, mm, gl } = makeApp();
    const { handleMessagePosted } = await import('../src/services/watch.ts');
    gl.pipelines.set(100, { id: 100, project_id: 7, status: 'running', ref: 'x', sha: 's', web_url: 'u' });
    gl.mr.head_pipeline = gl.pipelines.get(100)!;
    await handleMessagePosted(app, { id: 'up', channel_id: GENERAL, user_id: 'u_sara', message: `${PROJECT.web_url}/-/merge_requests/822`, root_id: '' });
    // GitLab breaks while the watch handles the merge...
    gl.getMr = async () => {
        throw new Error('gitlab down');
    };
    await send2(app, {
        object_kind: 'merge_request', user: { username: 'alice.dev' }, project: PROJECT,
        object_attributes: { iid: 822, title: 'feat(x): y', state: 'merged', action: 'merge', source_branch: 'a', target_branch: 'master', url: `${PROJECT.web_url}/-/merge_requests/822` },
    });
    // ...the channel still gets its merged card
    assert.match(mm.inChannel(UPDATES).map((p) => p.message).join('\n'), /merged/);
});

test('pipeline cards name and ping the CODE author, not only whoever triggered it; both get a DM', async () => {
    const { app, mm, gl } = makeApp();
    // the MR belongs to a teammate whose GitLab name differs from their Mattermost name; only the commit e-mail matches
    gl.mr.author = { id: 2, username: 'bob.dev', name: 'Bob' };
    const ev = pipelineEvent({ status: 'success', mrIid: 822, user: 'alice.dev' }) as { commit: Record<string, unknown> };
    ev.commit['author'] = { name: 'Bob', email: 'bob@example.com' };
    await send2(app, ev);
    const card = mm.inChannel(UPDATES)[0]!;
    assert.match(card.message, /@bob/, 'author pinged');
    assert.match(card.message, /@alice\.dev/, 'trigger pinged too');
    const text = card.props!.attachments![0]!.text!;
    assert.match(text, /\*\*Author\*\* \| @bob/);
    assert.match(text, /\*\*Triggered by\*\* \| @alice\.dev/);
    assert.equal(mm.dmsTo('u_bob').length, 1);
    assert.equal(mm.dmsTo('u_alice').length, 1);
    assert.equal(app.users.byGitlab('bob.dev')?.mm_username, 'bob', 'link stored from the commit e-mail');
});

test('post-merge pipeline on master credits the author of the merged MR, not the person who merged it', async () => {
    const { app, mm, gl } = makeApp();
    gl.commitMrs = [{ ...gl.mr, state: 'merged', author: { id: 2, username: 'bob.dev', name: 'Bob' } }];
    app.users.link('bob.dev', { id: 'u_bob', username: 'bob' }, 'manual');
    const ev = pipelineEvent({ status: 'success', mrIid: null, user: 'alice.dev' }) as { commit: Record<string, unknown> };
    ev.commit['title'] = "Merge branch 'release/x' into 'master'";
    await send2(app, ev);
    assert.match(mm.inChannel(UPDATES)[0]!.message, /@bob/);
});

test('/gl unlinked lists GitLab users that could not be matched', async () => {
    const { app, gl } = makeApp();
    gl.mr.author = { id: 5, username: 'stranger.dev', name: 'Stranger' };
    await send2(app, pipelineEvent({ status: 'success', mrIid: 822 }));
    const r = await handleSlash(app, { user_id: 'u_alice', user_name: 'alice', channel_id: GENERAL, text: 'unlinked' });
    assert.match(r.text, /stranger\.dev/);
    app.users.link('stranger.dev', { id: 'u_sara', username: 'sara' }, 'manual');
    assert.doesNotMatch((await handleSlash(app, { user_id: 'u_alice', user_name: 'alice', channel_id: GENERAL, text: 'unlinked' })).text, /stranger\.dev/);
});

test('a refused DM (user blocked/deactivated) is not retried and pauses DMs to that user; transient errors still retry', async () => {
    const { MattermostError } = await import('../src/mattermost/client.ts');
    const { app, mm } = makeApp();
    linkAlice(app);
    mm.dmChannel = async () => {
        throw new MattermostError('403 forbidden', 403);
    };
    await send(app, pipelineEvent({ id: 1, status: 'success' }), 1);
    const row = app.db.prepare(`SELECT status, attempts FROM scheduled WHERE kind='dm'`).get() as { status: string; attempts: number };
    assert.deepEqual({ ...row }, { status: 'dead', attempts: 1 });
    // a later pipeline does not even try
    await send(app, pipelineEvent({ id: 2, status: 'success' }), 2);
    assert.equal((app.db.prepare(`SELECT COUNT(*) n FROM scheduled WHERE kind='dm'`).get() as { n: number }).n, 1);

    // a 500 is transient: stays pending for another try
    const { app: app2, mm: mm2 } = makeApp();
    linkAlice(app2);
    mm2.dmChannel = async () => {
        throw new MattermostError('boom', 500);
    };
    await send(app2, pipelineEvent({ id: 3, status: 'success' }), 1);
    assert.equal((app2.db.prepare(`SELECT status FROM scheduled WHERE kind='dm'`).get() as { status: string }).status, 'pending');
});

test('inbox events refused for good are parked after 3 tries instead of 20', async () => {
    const { MattermostError } = await import('../src/mattermost/client.ts');
    const { app, mm } = makeApp();
    const http = createHttpApp(app, { kick: () => undefined, socketConnected: () => true });
    mm.createPost = async () => {
        throw new MattermostError('403 not a member', 403);
    };
    await http.request('/hooks/gitlab', { method: 'POST', body: JSON.stringify(pipelineEvent({ status: 'failed' })), headers: { 'x-gitlab-token': 'whsecret', 'x-gitlab-event-uuid': 'p1' } });
    const { drainInbound } = await import('../src/services/ingest.ts');
    for (let i = 0; i < 4; i++) {
        app.db.prepare(`UPDATE inbound_events SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE status='pending'`).run();
        await drainInbound(app);
    }
    const r = app.db.prepare(`SELECT status, attempts FROM inbound_events`).get() as { status: string; attempts: number };
    assert.deepEqual({ ...r }, { status: 'dead', attempts: 3 });
});

test('Show logs: instant acknowledgement; always posted as a reply to the card, in DMs and channels', async () => {
    const { handleAction, settleActions } = await import('../src/services/actions.ts');
    const { signContext } = await import('../src/mattermost/sign.ts');
    const { app, mm, gl } = makeApp();
    gl.jobs.set(100, [{ id: 2, name: 'unit-tests', stage: 'test', status: 'failed', allow_failure: false, web_url: 'u' }]);
    gl.traces.set(2, 'assertion failed at a.ts:1');
    const base = { action: 'show_logs', projectId: 7, projectPath: 'p', pipelineId: 100 };
    const dm = await handleAction(app, { user_id: 'u_alice', channel_id: 'dm_chan', post_id: 'card', context: signContext('signsecret', { ...base, dm: 1 }) });
    assert.match(dm.ephemeral_text!, /Fetching/);
    await settleActions();
    const inline = mm.posts.find((p) => p.channel_id === 'dm_chan')!;
    assert.match(inline.message, /assertion failed/);
    assert.equal(inline.root_id, 'card', 'DM result is a reply to the card');

    await handleAction(app, { user_id: 'u_alice', channel_id: UPDATES, post_id: 'card2', context: signContext('signsecret', base) });
    await settleActions();
    assert.equal(mm.posts.find((p) => p.channel_id === UPDATES)!.root_id, 'card2', 'channel reply stays in the thread');

    // no failed jobs (e.g. pipeline was retried): a visible explanation, not silence
    gl.jobs.set(100, []);
    await handleAction(app, { user_id: 'u_alice', channel_id: 'dm_chan', post_id: 'card', context: signContext('signsecret', { ...base, dm: 1 }) });
    await settleActions();
    assert.match(mm.posts.filter((p) => p.channel_id === 'dm_chan').at(-1)!.message, /no failed jobs/);
});

test('pipeline DM carries retry + logs buttons', async () => {
    const { app, mm } = makeApp();
    app.users.link('alice.dev', { id: 'u_alice', username: 'alice.dev' }, 'manual');
    await send2(app, pipelineEvent({ status: 'failed' }));
    const dm = mm.dmsTo('u_alice')[0]!;
    assert.deepEqual(dm.props!.attachments![0]!.actions!.map((a) => a.id), ['retry_pipeline', 'show_logs']);
});

test('Show logs includes allow_failure jobs that failed (pipeline green, one allowed failure)', async () => {
    const { handleAction, settleActions } = await import('../src/services/actions.ts');
    const { signContext } = await import('../src/mattermost/sign.ts');
    const { app, mm, gl } = makeApp();
    gl.jobs.set(100, [{ id: 2, name: 'test', stage: 'test', status: 'failed', allow_failure: true, web_url: 'u' }]);
    gl.traces.set(2, 'allowed failure output');
    await handleAction(app, { user_id: 'u_alice', channel_id: 'dm_chan', post_id: 'card', context: signContext('signsecret', { action: 'show_logs', projectId: 7, projectPath: 'p', pipelineId: 100, dm: 1 }) });
    await settleActions();
    const p = mm.posts.find((x) => x.channel_id === 'dm_chan')!;
    assert.match(p.message, /allowed failure output/);
    assert.equal(p.root_id, 'card');
});

test('a refreshed open MR card still says "opened", not "updated"', async () => {
    const { app, mm } = makeApp();
    await send(app, { object_kind: 'merge_request', user: { username: 'alice.dev', name: 'Alice' }, project: PROJECT, object_attributes: { iid: 822, title: 't', state: 'opened', action: 'open', url: `${PROJECT.web_url}/-/merge_requests/822`, source_branch: 'feat/hero', target_branch: 'master', created_at: '2026-11-14 07:00:00 UTC', updated_at: '2026-11-14 07:00:00 UTC' } });
    await send(app, pipelineEvent({ id: 100, status: 'failed' }));
    const card = mm.inChannel(UPDATES).find((p) => p.message.includes('Merge request'))!;
    assert.match(card.message, /Merge request .*!822.* opened/);
    assert.doesNotMatch(card.message, /updated/);
});

test('/gl me reports DM types that are switched off globally as off', async () => {
    const { app } = makeApp();
    linkAlice(app);
    const r = await handleSlash(app, { user_id: 'u_alice', user_name: 'alice', channel_id: GENERAL, text: 'me' });
    assert.match(r.text, /Comment DMs \| off \(disabled by an admin\)/);
    assert.match(r.text, /Pipeline DMs \| on/);
});
