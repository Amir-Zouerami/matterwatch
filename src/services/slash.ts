import type { App } from '../app.ts';
import { FEATURES } from '../features/registry.ts';
import type { ScopeType } from '../features/service.ts';
import { code, link, table } from '../render/table.ts';
import { pipelineStyle } from '../render/theme.ts';
import { parseRefInput } from '../util/urls.ts';
import { relativeTime } from '../util/time.ts';
import { truncate } from '../util/text.ts';
import { errMsg } from '../logger.ts';
import { collectFailureLogs } from './failure-logs.ts';
import { renderLogPost } from '../render/cards.ts';
import { isAdmin } from './actions.ts';
import { unlinkedUsers } from './people.ts';
import { watchRef } from './watch.ts';
import { runDigest } from './digest.ts';

export interface SlashRequest {
    user_id: string;
    user_name: string;
    channel_id: string;
    text: string;
}

export interface SlashResponse {
    response_type: 'ephemeral' | 'in_channel';
    text: string;
}

const eph = (text: string): SlashResponse => ({ response_type: 'ephemeral', text });

const HELP = `#### GitLab helper
| Command | What it does |
|:--|:--|
| \`/gl watch <MR/pipeline URL>\` | Report that pipeline's result in this channel |
| \`/gl unwatch <URL>\\|all\` · \`/gl watches\` | Stop watching · list watches in this channel |
| \`/gl mrs [mine\\|reviewing]\` | Your open merge requests |
| \`/gl logs <pipeline URL>\` | Show the failed job logs of a pipeline |
| \`/gl link <gitlab-username>\` · \`/gl unlink\` · \`/gl me\` | Connect your GitLab account (for mentions, DMs and buttons) |
| \`/gl prefs <pipelines\\|reviews\\|comments\\|state\\|quiet> <on\\|off>\` · \`/gl prefs failures-only <on\\|off>\` | Personal notification settings |
| \`/gl features [group]\` | List feature switches |
| \`/gl features <on\\|off\\|reset> <key\\|group.*\\|all> [here\\|project <path>]\` | Toggle features (admins) |
| \`/gl mute <project path>\` · \`/gl unmute …\` · \`/gl route <project path> [here\\|default]\` | Per-project routing (admins) |
| \`/gl links\` · \`/gl link <gitlab> @user\` · \`/gl digest\` · \`/gl audit\` | Admin tools |`;

export async function handleSlash(app: App, req: SlashRequest): Promise<SlashResponse> {
    const [cmd = 'help', ...rest] = req.text.trim().split(/\s+/).filter(Boolean);
    // Admins can always reach `features`, otherwise `/gl features off all` would lock everyone (including them) out.
    if (!app.features.isEnabled('slash.commands', { channelId: req.channel_id }) && !(cmd.toLowerCase().startsWith('feature') && (await isAdmin(app, req.user_id)))) {
        return eph('🔕 The /gl command is switched off.');
    }
    const arg = rest.join(' ');
    try {
        switch (cmd.toLowerCase()) {
            case 'help': case '': return eph(HELP);
            case 'me': return me(app, req);
            case 'link': return doLink(app, req, rest);
            case 'unlink': return doUnlink(app, req, rest);
            case 'links': return needAdmin(app, req, () => listLinks(app));
            case 'unlinked': return needAdmin(app, req, () => unlinked(app));
            case 'prefs': return prefs(app, req, rest);
            case 'features': case 'feature': return features(app, req, rest);
            case 'watch': return watch(app, req, arg);
            case 'unwatch': return unwatch(app, req, arg);
            case 'watches': return watches(app, req);
            case 'mrs': return mrs(app, req, rest[0]);
            case 'logs': return logsCmd(app, req, arg);
            case 'mute': case 'unmute': return needAdmin(app, req, () => mute(app, cmd === 'mute', arg));
            case 'route': return needAdmin(app, req, () => route(app, req, rest));
            case 'projects': return needAdmin(app, req, () => projects(app));
            case 'digest': return needAdmin(app, req, async () => { await runDigest(app, { force: true }); return eph('Digest posted.'); });
            case 'audit': return needAdmin(app, req, () => audit(app));
            default: return eph(`Unknown command \`${cmd}\`.\n\n${HELP}`);
        }
    } catch (e) {
        return eph(`❌ ${errMsg(e).slice(0, 300)}`);
    }
}

async function needAdmin(app: App, req: SlashRequest, fn: () => Promise<SlashResponse> | SlashResponse): Promise<SlashResponse> {
    if (!(await isAdmin(app, req.user_id))) return eph('🔐 This needs a Mattermost system admin.');
    return fn();
}

function me(app: App, req: SlashRequest): SlashResponse {
    const u = app.users.byMm(req.user_id);
    if (!u) return eph('You are not linked yet. Use `/gl link <your-gitlab-username>`.');
    const p = u.prefs;
    const on = (v: boolean | undefined) => (v === false ? 'off' : 'on');
    return eph(`Linked to GitLab user **${u.gitlab_username}** (${u.source}).\n\n${table(['Setting', 'Value'], [['Pipeline DMs', on(p.dmPipelines)], ['Failures only', p.failuresOnly ? 'on' : 'off'], ['Review DMs', on(p.dmReviews)], ['Comment DMs', on(p.dmComments)], ['MR state DMs', on(p.dmState)], ['Quiet hours', on(p.quietHours)]])}`);
}

async function doLink(app: App, req: SlashRequest, rest: string[]): Promise<SlashResponse> {
    const gl = rest[0]?.replace(/^@/, '');
    if (!gl) return eph('Usage: `/gl link <gitlab-username>` (admins: `/gl link <gitlab-username> @mattermost-user`)');
    if (rest[1]) {
        if (!(await isAdmin(app, req.user_id))) return eph('🔐 Linking someone else needs a system admin.');
        const mmUser = await app.mm.userByUsername(rest[1].replace(/^@/, ''));
        if (!mmUser) return eph(`No Mattermost user ${rest[1]}.`);
        app.users.link(gl, mmUser, 'manual');
        app.audit.record({ actorMm: req.user_id, action: 'link', target: `${gl} → ${mmUser.username}`, result: 'ok' });
        return eph(`Linked **${gl}** → @${mmUser.username}.`);
    }
    const me = await app.mm.userById(req.user_id);
    if (!me) return eph('Could not read your Mattermost profile.');
    const glUser = await app.gl.findUserByUsername(gl).catch(() => null);
    if (!glUser) return eph(`GitLab user **${gl}** was not found.`);
    const admin = await isAdmin(app, req.user_id);
    const emailMatch = !!glUser.public_email && !!me.email && glUser.public_email.toLowerCase() === me.email.toLowerCase();
    const nameMatch = gl.toLowerCase() === me.username.toLowerCase();
    if (!emailMatch && !nameMatch && !admin) return eph(`I can't verify that **${gl}** is you (no matching email or username). Ask an admin to run \`/gl link ${gl} @${me.username}\`.`);
    app.users.link(gl, me, emailMatch ? 'email' : 'manual', glUser.id);
    app.audit.record({ actorMm: req.user_id, actorGl: gl, action: 'link', target: gl, result: 'ok' });
    return eph(`✅ Linked you to GitLab user **${gl}**. You will be mentioned on your MRs and pipelines.`);
}

async function doUnlink(app: App, req: SlashRequest, rest: string[]): Promise<SlashResponse> {
    if (rest[0]) {
        if (!(await isAdmin(app, req.user_id))) return eph('🔐 Unlinking someone else needs a system admin.');
        return eph(app.users.unlink(rest[0].replace(/^@/, '')) ? `Unlinked ${rest[0]}.` : 'Not linked.');
    }
    const u = app.users.byMm(req.user_id);
    if (!u) return eph('You are not linked.');
    app.users.unlink(u.gitlab_username);
    return eph('Unlinked.');
}

function unlinked(app: App): SlashResponse {
    const rows = unlinkedUsers(app).slice(0, 25).map((u) => [u.username, String(u.n), relativeTime(new Date(u.last))]);
    return eph(rows.length ? `**GitLab users the bot could not match to a Mattermost account** — link each with \`/gl link <gitlab-user> @mattermost-user\`\n${table(['GitLab user', 'Seen', 'Last'], rows)}` : 'Everyone seen so far is linked. 🎉');
}

function listLinks(app: App): SlashResponse {
    const rows = app.users.all().map((u) => [u.gitlab_username, `@${u.mm_username}`, u.source]);
    return eph(rows.length ? table(['GitLab', 'Mattermost', 'How'], rows) : 'No links yet.');
}

function prefs(app: App, req: SlashRequest, rest: string[]): SlashResponse {
    const u = app.users.byMm(req.user_id);
    if (!u) return eph('Link your account first: `/gl link <gitlab-username>`.');
    const [what, val] = rest;
    const map: Record<string, keyof typeof u.prefs> = { pipelines: 'dmPipelines', reviews: 'dmReviews', comments: 'dmComments', state: 'dmState', quiet: 'quietHours', 'failures-only': 'failuresOnly' };
    const key = what ? map[what] : undefined;
    if (!key || (val !== 'on' && val !== 'off')) return eph('Usage: `/gl prefs <pipelines|reviews|comments|state|quiet|failures-only> <on|off>`');
    app.users.setPrefs(u.gitlab_username, { [key]: val === 'on' });
    return eph(`Saved: ${what} → ${val}.`);
}

async function features(app: App, req: SlashRequest, rest: string[]): Promise<SlashResponse> {
    const [verb, pattern, scopeWord, scopeVal] = rest;
    const channelCtx = { channelId: req.channel_id };
    if (!verb || (verb !== 'on' && verb !== 'off' && verb !== 'reset')) {
        const group = verb;
        const snap = app.features.snapshot(channelCtx).filter((f) => !group || f.group === group || f.key.startsWith(group));
        if (snap.length === 0) return eph(`No features match \`${group}\`. Groups: ${[...new Set(FEATURES.map((f) => f.group))].join(', ')}`);
        const rows = snap.map((f) => [`${f.enabled ? '🟢' : '⚪'} ${code(f.key)}`, f.description]);
        return eph(`${table(['Feature (as seen in this channel)', 'What it does'], rows)}\n\nToggle: \`/gl features off <key|group.*|all> [here|project <path>]\``);
    }
    if (!(await isAdmin(app, req.user_id))) return eph('🔐 Toggling features needs a system admin.');
    if (!pattern) return eph('Usage: `/gl features <on|off|reset> <key|group.*|all> [here|project <path>]`');
    const keys = app.features.expand(pattern);
    if (keys.length === 0) return eph(`Unknown feature \`${pattern}\`.`);
    let scope: { type: ScopeType; id: string } | null = null;
    let label = 'globally';
    if (scopeWord === 'here') {
        scope = { type: 'channel', id: req.channel_id };
        label = 'in this channel';
    } else if (scopeWord === 'project' && scopeVal) {
        const p = app.projects.byPath(scopeVal);
        if (!p) return eph(`Unknown project \`${scopeVal}\` (I only know projects that have sent events).`);
        scope = { type: 'project', id: String(p.project_id) };
        label = `for ${scopeVal}`;
    }
    for (const k of keys) {
        if (verb === 'reset') {
            if (scope) app.features.clearOverride(k, scope.type, scope.id);
            else app.features.clearGlobal(k);
        } else if (scope) app.features.setOverride(k, scope.type, scope.id, verb === 'on', req.user_name);
        else app.features.setGlobal(k, verb === 'on', req.user_name);
    }
    app.audit.record({ actorMm: req.user_id, action: `features ${verb}`, target: `${pattern} ${label}`, result: `${keys.length} features` });
    return eph(`${verb === 'off' ? '⚪ Turned off' : verb === 'on' ? '🟢 Turned on' : '↩️ Reset'} ${keys.length === 1 ? code(keys[0]!) : `${keys.length} features (${code(pattern)})`} ${label}.`);
}

async function watch(app: App, req: SlashRequest, arg: string): Promise<SlashResponse> {
    if (!app.features.isEnabled('actions.watch', { channelId: req.channel_id })) return eph('🔕 Watching is switched off (`actions.watch`).');
    const ref = parseRefInput(arg, app.cfg.GITLAB_URL);
    if (!ref || ref.kind === 'job') return eph('Give me a merge request or pipeline URL, or `group/project!123`.');
    const res = await watchRef(app, ref, { channelId: req.channel_id, rootPostId: null, postId: null, userId: req.user_id, force: true });
    if (res.status === 'created') return eph(`👀 Watching ${link(ref.url, ref.url)} — I will post the result here.`);
    if (res.status === 'exists') return eph('Already watching that in this channel.');
    return eph(`Not watching: ${res.reason ?? 'skipped'}.`);
}

function unwatch(app: App, req: SlashRequest, arg: string): SlashResponse {
    const active = app.watches.forChannel(req.channel_id);
    if (arg === 'all') {
        active.forEach((w) => app.watches.stop(w.id));
        return eph(`Stopped ${active.length} watch(es) in this channel.`);
    }
    const ref = parseRefInput(arg, app.cfg.GITLAB_URL);
    if (!ref || ref.kind === 'job') return eph('Usage: `/gl unwatch <URL>` or `/gl unwatch all`.');
    const key = ref.kind === 'mr' ? String(ref.iid) : String(ref.id);
    const hit = active.filter((w) => w.project_path === ref.projectPath && w.kind === ref.kind && w.ref === key);
    hit.forEach((w) => app.watches.stop(w.id));
    return eph(hit.length ? 'Stopped.' : 'No such watch in this channel.');
}

function watches(app: App, req: SlashRequest): SlashResponse {
    const list = app.watches.forChannel(req.channel_id);
    if (list.length === 0) return eph('Nothing is being watched in this channel.');
    return eph(table(['What', 'Project', 'Since'], list.map((w) => [w.kind === 'mr' ? `!${w.ref}` : `pipeline #${w.ref}`, w.project_path, relativeTime(new Date(w.created_at))])));
}

async function mrs(app: App, req: SlashRequest, mode?: string): Promise<SlashResponse> {
    const u = app.users.byMm(req.user_id);
    if (!u) return eph('Link your account first: `/gl link <gitlab-username>`.');
    const reviewing = mode === 'reviewing';
    const list = await app.gl.listMrs(reviewing ? { reviewerUsername: u.gitlab_username } : { authorUsername: u.gitlab_username });
    if (list.length === 0) return eph(reviewing ? 'Nothing waiting for your review. 🎉' : 'You have no open merge requests.');
    const rows = list.slice(0, 20).map((m) => [
        link(`!${m.iid}`, m.web_url),
        truncate(m.title, 60),
        m.head_pipeline ? `${pipelineStyle(m.head_pipeline.status).emoji} ${m.head_pipeline.status}` : '—',
        relativeTime(new Date(m.updated_at)),
    ]);
    return eph(`**${reviewing ? 'Waiting for your review' : 'Your open merge requests'}**\n${table(['MR', 'Title', 'Pipeline', 'Updated'], rows)}`);
}

async function logsCmd(app: App, req: SlashRequest, arg: string): Promise<SlashResponse> {
    const ref = parseRefInput(arg, app.cfg.GITLAB_URL);
    if (!ref || ref.kind !== 'pipeline') return eph('Usage: `/gl logs <pipeline URL>`.');
    const project = await app.gl.getProject(ref.projectPath);
    const logs = await collectFailureLogs(app, project.id, ref.id);
    if (logs.length === 0) return eph('No failed jobs with logs in that pipeline.');
    for (const l of logs) {
        await app.mm.createPost({ channel_id: req.channel_id, message: renderLogPost({ jobName: l.job.name, jobUrl: l.job.web_url, stage: l.job.stage, reason: l.job.failure_reason ?? null, lines: app.cfg.FAILURE_LOG_LINES, truncated: l.truncated, log: l.tail || '(empty log)', fileNote: null }) });
    }
    return eph(`Posted ${logs.length} job log(s).`);
}

function mute(app: App, on: boolean, path: string): SlashResponse {
    const p = app.projects.byPath(path);
    if (!p) return eph(`Unknown project \`${path}\`.`);
    app.projects.setMuted(p.project_id, on);
    return eph(`${on ? '🔇 Muted' : '🔔 Unmuted'} ${code(path)}.`);
}

function route(app: App, req: SlashRequest, rest: string[]): SlashResponse {
    const [path, where] = rest;
    const p = path ? app.projects.byPath(path) : null;
    if (!p) return eph('Usage: `/gl route <project path> [here|default]` (project must have sent an event before).');
    if (where === 'here') app.projects.setChannel(p.project_id, req.channel_id);
    else if (where === 'default') app.projects.setChannel(p.project_id, null);
    else return eph(`${code(p.path)} → ${p.channel_id ? `<channel ${p.channel_id}>` : 'default channel'}. Use \`here\` or \`default\` to change.`);
    return eph(`Routed ${code(p.path)} → ${where === 'here' ? 'this channel' : 'the default channel'}.`);
}

function projects(app: App): SlashResponse {
    const rows = app.projects.list().map((p) => [p.path, p.muted ? '🔇 muted' : 'active', p.channel_id ?? 'default']);
    return eph(rows.length ? table(['Project', 'State', 'Channel'], rows) : 'No projects seen yet.');
}

function audit(app: App): SlashResponse {
    const rows = app.audit.recent(15).map((a) => [relativeTime(new Date(a.ts)), a.actor_gl ?? a.actor_mm ?? '—', a.action, a.target ?? '', truncate(a.result, 40)]);
    return eph(rows.length ? table(['When', 'Who', 'Action', 'Target', 'Result'], rows) : 'Audit log is empty.');
}
