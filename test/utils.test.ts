import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMessageBody, maskSecrets, parseConventionalTitle, stripAnsi, tailLines } from '../src/util/text.ts';
import { extractGitlabRefs, parseRefInput } from '../src/util/urls.ts';
import { inQuietHours, nextLocalHour, parseGitlabDate, localParts } from '../src/util/time.ts';
import { signContext, verifyContext } from '../src/mattermost/sign.ts';

test('parseConventionalTitle splits type/scope/subject', () => {
    assert.deepEqual(parseConventionalTitle('fix(countdown): add none option'), { type: 'fix', scope: 'countdown', breaking: false, subject: 'add none option' });
    assert.equal(parseConventionalTitle('feat(api)!: drop v1').breaking, true);
    assert.equal(parseConventionalTitle('Merge branch x into y').type, null);
});

test('cleanMessageBody strips trailers', () => {
    assert.equal(cleanMessageBody('Body\n\nCo-Authored-By: Jane Doe <x>\nSigned-off-by: Jo <y>'), 'Body');
});

test('maskSecrets hides tokens, keys and passwords', () => {
    const raw = 'token glpat-abcdefghijklmnop1234\nDB_PASSWORD=hunter2hunter\nAuthorization: Bearer abcdefghijklmnopqrstu\nurl https://user:pass123@host/x\nok line';
    const out = maskSecrets(raw, ['hunter2hunter']);
    assert.ok(!out.includes('glpat-abcdefghijklmnop1234'));
    assert.ok(!out.includes('hunter2hunter'));
    assert.ok(!out.includes('abcdefghijklmnopqrstu'));
    assert.ok(!out.includes('pass123'));
    assert.ok(out.includes('ok line'));
});

test('stripAnsi and tailLines', () => {
    assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
    assert.equal(tailLines('a\nb\nc\nd\n', 2), 'c\nd');
});

test('extractGitlabRefs finds MR and pipeline links, ignores other hosts', () => {
    const t = 'see https://gitlab.example.com/acme/front-end/product/sections_project/-/merge_requests/822, and https://gitlab.example.com/g/p/-/pipelines/55 but not https://github.com/a/b/-/merge_requests/1';
    const refs = extractGitlabRefs(t, 'https://gitlab.example.com');
    assert.equal(refs.length, 2);
    assert.deepEqual(refs[0], { kind: 'mr', projectPath: 'acme/front-end/product/sections_project', iid: 822, url: 'https://gitlab.example.com/acme/front-end/product/sections_project/-/merge_requests/822' });
    assert.equal(refs[1]!.kind, 'pipeline');
    assert.equal(parseRefInput('g/p!12', 'https://gitlab.example.com')?.kind, 'mr');
});

test('quiet hours wrap past midnight', () => {
    assert.equal(inQuietHours(23, 23, 8), true);
    assert.equal(inQuietHours(3, 23, 8), true);
    assert.equal(inQuietHours(8, 23, 8), false);
    assert.equal(inQuietHours(12, 23, 8), false);
    assert.equal(inQuietHours(5, 0, 0), false);
});

test('nextLocalHour lands on the requested Tokyo hour', () => {
    const next = nextLocalHour(new Date('2026-11-14T22:00:00Z'), 8, 'Asia/Tokyo');
    assert.equal(localParts(next, 'Asia/Tokyo').hour, 8);
    assert.ok(next.getTime() > new Date('2026-11-14T22:00:00Z').getTime());
});

test('parseGitlabDate handles GitLab formats', () => {
    assert.equal(parseGitlabDate('2026-11-14 07:07:34 UTC')?.toISOString(), '2026-11-14T07:07:34.000Z');
    assert.equal(parseGitlabDate('2026-11-14T07:07:34.271Z')?.toISOString(), '2026-11-14T07:07:34.271Z');
    assert.equal(parseGitlabDate(null), null);
});

test('signed button context verifies and rejects tampering', () => {
    const ctx = signContext('s', { action: 'retry_pipeline', projectId: 7, pipelineId: 1 });
    assert.equal(verifyContext('s', ctx), true);
    assert.equal(verifyContext('other', ctx), false);
    assert.equal(verifyContext('s', { ...ctx, pipelineId: 2 }), false);
    assert.equal(verifyContext('s', { action: 'x' }), false);
});
