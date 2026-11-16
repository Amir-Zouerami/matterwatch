import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UPDATES, makeApp, pipelineEvent, PROJECT } from './helpers.ts';
import { parseEvent } from '../src/gitlab/events.ts';
import { dispatchEvent } from '../src/services/handlers.ts';
import { createHttpApp } from '../src/http/app.ts';
import { endpointKey, signContext } from '../src/mattermost/sign.ts';

async function send(app: ReturnType<typeof makeApp>['app'], payload: unknown): Promise<void> {
    const parsed = parseEvent(payload);
    assert.ok(parsed.ok);
    await dispatchEvent(app, parsed.event);
}

const mr = (action: string, extra: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}) => ({
    object_kind: 'merge_request', user: { username: 'alice.dev', name: 'Alice' }, project: PROJECT,
    object_attributes: { iid: 5, title: 'fix(x): y', state: action === 'merge' ? 'merged' : action === 'close' ? 'closed' : 'opened', action, source_branch: 'a', target_branch: 'master', url: `${PROJECT.web_url}/-/merge_requests/5`, ...attrs },
    ...extra,
});

test('default channel policy: unimportant events post nothing', async () => {
    const { app, mm } = makeApp();
    await send(app, { object_kind: 'push', before: '1'.repeat(40), after: '2'.repeat(40), ref: 'refs/heads/random', user_username: 'x', commits: [{ id: '2'.repeat(40), title: 't' }], total_commits_count: 1, project: PROJECT });
    await send(app, { object_kind: 'tag_push', before: '0'.repeat(40), after: '2'.repeat(40), ref: 'refs/tags/v1', user_username: 'x', project: PROJECT });
    await send(app, { object_kind: 'issue', user: { username: 'x' }, project: PROJECT, object_attributes: { iid: 1, title: 'bug', action: 'open', url: 'u' } });
    await send(app, { object_kind: 'note', user: { username: 'x' }, project: PROJECT, object_attributes: { id: 1, note: 'hi', noteable_type: 'MergeRequest', url: 'u' }, merge_request: { iid: 5, title: 't' } });
    await send(app, { object_kind: 'deployment', status: 'success', environment: 'staging', project: PROJECT });
    await send(app, { object_kind: 'release', action: 'create', tag: 'v1', project: PROJECT });
    assert.equal(mm.posts.length, 0);
    assert.equal(app.features.isEnabled('digest.daily'), false);
});

test('MR: opened and merged get cards; label edits and approvals never create one', async () => {
    const { app, mm } = makeApp();
    await send(app, mr('update', { changes: { labels: { previous: [], current: [{ title: 'x' }] } } }));
    await send(app, mr('approved'));
    assert.equal(mm.posts.length, 0, 'no card for updates on an MR we never announced');

    await send(app, mr('open'));
    assert.equal(mm.posts.length, 1);
    await send(app, mr('approved'));
    await send(app, mr('close'));
    assert.equal(mm.posts.length, 1, 'later changes edit the same card');
    assert.ok(mm.patches.length >= 2);
    assert.deepEqual(mm.posts[0]!.props!.attachments![0]!.actions ?? [], [], 'closed MR card has no buttons');
});

test('MR merged without an earlier card still reports', async () => {
    const { app, mm } = makeApp();
    await send(app, mr('merge', {}, { merge_commit_sha: 'c'.repeat(40) }));
    assert.equal(mm.posts.length, 1);
    assert.match(mm.posts[0]!.message, /merged/);
});

test('review request added later pings the reviewer in the card thread', async () => {
    const { app, mm } = makeApp();
    app.users.link('sara', { id: 'u_sara', username: 'sara' }, 'manual');
    await send(app, mr('open'));
    const card = mm.posts[0]!.id;
    await send(app, mr('update', { changes: { reviewers: { previous: [], current: [{ username: 'sara', name: 'Sara' }] } }, reviewers: [{ username: 'sara', name: 'Sara' }] }));
    const ping = mm.posts.find((p) => p.root_id === card)!;
    assert.ok(ping);
    assert.match(ping.message, /@sara/);
    assert.match(ping.message, /review requested/);
    assert.equal(mm.dmsTo('u_sara').length, 1, 'and a DM');
});

test('review request on an unannounced MR creates the card', async () => {
    const { app, mm } = makeApp();
    await send(app, mr('update', { changes: { reviewers: { previous: [], current: [{ username: 'sara', name: 'Sara' }] } }, reviewers: [{ username: 'sara', name: 'Sara' }] }));
    assert.equal(mm.inChannel(UPDATES).length, 1);
});

test('every pipeline state shows up, as one edited card', async () => {
    const { app, mm } = makeApp();
    for (const s of ['created', 'pending', 'running', 'manual', 'success']) await send(app, pipelineEvent({ status: s }));
    assert.equal(mm.inChannel(UPDATES).length, 1, 'one card in the channel (the author also gets a DM)');
    assert.equal(mm.patches.length, 4);
    assert.match(mm.posts[0]!.message, /passed/);
});

test('button endpoint requires the endpoint key', async () => {
    const { app } = makeApp();
    const http = createHttpApp(app, { kick: () => undefined, socketConnected: () => true });
    const body = JSON.stringify({ user_id: 'u', channel_id: 'c', post_id: 'p', context: signContext('signsecret', { action: 'show_logs' }) });
    assert.equal((await http.request('/mm/actions', { method: 'POST', body })).status, 401);
    assert.equal((await http.request('/mm/actions?k=bad', { method: 'POST', body })).status, 401);
    const ok = await http.request(`/mm/actions?k=${endpointKey('signsecret', 'actions')}`, { method: 'POST', body });
    assert.equal(ok.status, 200);
});
