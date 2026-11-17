import type { MmAttachment, MmButton, OutPost } from '../mattermost/types.ts';
import { endpointKey, signContext } from '../mattermost/sign.ts';
import { cleanMessageBody, firstLine, mdCell, parseConventionalTitle, shortSha, truncate, typeEmoji } from '../util/text.ts';
import { formatDuration, formatLocal } from '../util/time.ts';
import { JOB_EMOJI, mrStyle, pipelineStyle } from './theme.ts';
import { code, kvTable, link, table } from './table.ts';

export interface RenderOpts {
    tz: string;
    jalali: boolean;
    conventional: boolean;
    serviceUrl: string;
    secret: string;
}

export interface PersonView {
    /** What goes into text: "@mm.user" when linked, else the GitLab display name. */
    mention: string;
    gitlab: string;
}

export interface ButtonSpec {
    id: string;
    name: string;
    style?: MmButton['style'];
    context: Record<string, unknown>;
}

export function buttons(opts: RenderOpts, specs: ButtonSpec[]): MmButton[] {
    return specs.map((b) => ({
        id: b.id,
        name: b.name,
        type: 'button' as const,
        style: b.style ?? 'default',
        integration: { url: `${opts.serviceUrl}/mm/actions?k=${endpointKey(opts.secret, 'actions')}`, context: signContext(opts.secret, { action: b.id, ...b.context }) },
    }));
}

function titleLine(title: string, opts: RenderOpts): { text: string; type: string | null } {
    if (!opts.conventional) return { text: title, type: null };
    const p = parseConventionalTitle(title);
    if (!p.type) return { text: title, type: null };
    const scope = p.scope ? ` ${code(p.scope)}` : '';
    return { text: `${typeEmoji(p.type)} **${p.type}**${scope}${p.breaking ? ' ⚠️ **BREAKING**' : ''} ${p.subject}`, type: p.type };
}

const names = (ps: PersonView[]): string => ps.map((p) => p.mention).join(', ');

export interface MrView {
    projectPath: string;
    projectUrl: string;
    projectId: number;
    iid: number;
    title: string;
    url: string;
    state: string;
    draft: boolean;
    source: string;
    target: string;
    action: string | null;
    actor: PersonView | null;
    author: PersonView | null;
    reviewers: PersonView[];
    assignees: PersonView[];
    labels: string[];
    description?: string | null;
    updatedAt: Date | null;
    pipeline: { id: number; status: string; url: string } | null;
    mergeStatus?: string | null;
}

const MR_ACTION_VERB: Record<string, string> = {
    open: 'opened',
    reopen: 'reopened',
    close: 'closed',
    merge: 'merged',
    approved: 'approved',
    approval: 'approved',
    unapproved: 'approval removed from',
    unapproval: 'approval removed from',
    update: 'updated',
};

export function renderMrCard(v: MrView, opts: RenderOpts, btns: ButtonSpec[], mentions: boolean): OutPost & { channel_id: '' } {
    const st = mrStyle(v.state, v.draft);
    const t = titleLine(v.title, opts);
    // No webhook action (the card was refreshed from the API): describe the MR by its state instead of a bare "updated".
    const verb = (v.action && MR_ACTION_VERB[v.action]) || (v.state === 'opened' || v.state === 'merged' || v.state === 'closed' ? v.state : 'updated');
    const who = v.actor ? ` by ${mentions ? v.actor.mention : v.actor.gitlab}` : '';
    const ping = mentions ? [...v.reviewers, ...v.assignees].filter((p) => p.mention.startsWith('@')).map((p) => p.mention) : [];
    const pingText = ping.length ? `\n${[...new Set(ping)].join(' ')} — your review is requested` : '';
    const message = `${st.emoji} **Merge request ${link(`!${v.iid}`, v.url)} ${verb}**${who}${v.action === 'open' || v.action === 'reopen' ? pingText : ''}`;

    const pl = v.pipeline ? `${pipelineStyle(v.pipeline.status).emoji} ${link(`#${v.pipeline.id} ${pipelineStyle(v.pipeline.status).label}`, v.pipeline.url)}` : null;
    const text = [
        `#### ${t.text}`,
        kvTable([
            ['Project', link(v.projectPath, v.projectUrl)],
            ['Branch', `${code(v.source)} → ${code(v.target)}`],
            ['Status', `${st.emoji} ${st.label}${v.mergeStatus && v.state === 'opened' ? ` · ${v.mergeStatus.replace(/_/g, ' ')}` : ''}`],
            ['Author', v.author ? (mentions ? v.author.mention : v.author.gitlab) : null],
            ['Reviewers', v.reviewers.length ? names(v.reviewers) : null],
            ['Assignees', v.assignees.length ? names(v.assignees) : null],
            ['Pipeline', pl],
            ['Labels', v.labels.length ? v.labels.map(code).join(' ') : null],
            ['Updated', formatLocal(v.updatedAt, opts.tz, opts.jalali)],
        ]),
        v.description && v.action === 'open' ? `> ${truncate(cleanMessageBody(v.description).replace(/\n+/g, ' '), 220)}` : '',
    ]
        .filter(Boolean)
        .join('\n\n');

    const att: MmAttachment = {
        fallback: `MR !${v.iid} ${v.title} (${st.label})`,
        color: st.color,
        title: `!${v.iid} · ${firstLine(v.title)}`,
        title_link: v.url,
        text,
        footer: `${v.projectPath} · !${v.iid}`,
    };
    if (btns.length) att.actions = buttons(opts, btns);
    return { channel_id: '', message, props: { attachments: [att] } };
}

export interface JobView {
    id: number;
    name: string;
    stage: string;
    status: string;
    duration: number | null;
    allowFailure: boolean;
    url?: string;
}

export interface PipelineView {
    projectPath: string;
    projectUrl: string;
    projectId: number;
    id: number;
    url: string;
    status: string;
    ref: string;
    isTag: boolean;
    sha: string;
    commitTitle: string | null;
    source: string | null;
    duration: number | null;
    actor: PersonView | null;
    author: PersonView | null;
    mr: { iid: number; title: string; url: string; state?: string } | null;
    jobs: JobView[];
    finishedAt: Date | null;
}

export function renderJobsTable(jobs: JobView[], max = 12): string {
    if (jobs.length === 0) return '';
    const rank = (j: JobView): number => (j.status === 'failed' && !j.allowFailure ? 0 : j.status === 'failed' ? 1 : j.status === 'running' ? 2 : 3);
    const sorted = [...jobs].sort((a, b) => rank(a) - rank(b));
    const shown = sorted.slice(0, max);
    const rows = shown.map((j) => [
        j.stage,
        j.url ? link(j.name, j.url) : j.name,
        `${JOB_EMOJI[j.status] ?? '❔'} ${j.status}${j.allowFailure && j.status === 'failed' ? ' (allowed)' : ''}`,
        formatDuration(j.duration),
    ]);
    const more = jobs.length > shown.length ? `\n_…and ${jobs.length - shown.length} more jobs_` : '';
    return table(['Stage', 'Job', 'Result', 'Time'], rows) + more;
}

export function renderPipelineCard(v: PipelineView, opts: RenderOpts, btns: ButtonSpec[], mentions: boolean): OutPost & { channel_id: '' } {
    const st = pipelineStyle(v.status);
    const failedJobs = v.jobs.filter((j) => j.status === 'failed' && !j.allowFailure);
    const target = v.mr ? `MR ${link(`!${v.mr.iid}`, v.mr.url)}` : v.isTag ? `tag ${code(v.ref)}` : `branch ${code(v.ref)}`;
    const pingNames = mentions && (v.status === 'failed' || v.status === 'success')
        ? [...new Set([v.author, v.actor].filter((p): p is PersonView => !!p && p.mention.startsWith('@')).map((p) => p.mention))]
        : [];
    const ping = pingNames.length ? ` — ${pingNames.join(' ')}` : '';
    const message = `${st.emoji} **Pipeline ${link(`#${v.id}`, v.url)} ${st.label}** on ${target}${ping}`;

    const failSummary = failedJobs.length
        ? `**Failed:** ${failedJobs.slice(0, 5).map((j) => (j.url ? link(j.name, j.url) : j.name)).join(', ')}${failedJobs.length > 5 ? ` +${failedJobs.length - 5}` : ''}`
        : '';
    const text = [
        v.commitTitle ? `#### ${titleLine(firstLine(v.commitTitle), opts).text}` : '',
        kvTable([
            ['Project', link(v.projectPath, v.projectUrl)],
            [v.mr ? 'Merge request' : v.isTag ? 'Tag' : 'Branch', v.mr ? `${link(`!${v.mr.iid}`, v.mr.url)} ${truncate(v.mr.title, 80)}` : code(v.ref)],
            ['Commit', code(shortSha(v.sha))],
            ['Author', v.author && v.author.gitlab !== v.actor?.gitlab ? (mentions ? v.author.mention : v.author.gitlab) : null],
            [v.author && v.author.gitlab !== v.actor?.gitlab ? 'Triggered by' : 'Author / triggered by', v.actor ? (mentions ? v.actor.mention : v.actor.gitlab) : null],
            ['Source', v.source ? v.source.replace(/_/g, ' ') : null],
            ['Duration', v.duration ? formatDuration(v.duration) : null],
            ['Finished', v.finishedAt ? formatLocal(v.finishedAt, opts.tz, opts.jalali) : null],
        ]),
        failSummary,
        renderJobsTable(v.jobs),
    ]
        .filter(Boolean)
        .join('\n\n');

    const att: MmAttachment = {
        fallback: `Pipeline #${v.id} ${st.label} (${v.projectPath})`,
        color: st.color,
        title: `Pipeline #${v.id}`,
        title_link: v.url,
        text,
        footer: `${v.projectPath} · #${v.id}`,
    };
    if (btns.length) att.actions = buttons(opts, btns);
    return { channel_id: '', message, props: { attachments: [att] } };
}

export interface PushView {
    projectPath: string;
    projectUrl: string;
    branch: string;
    pusher: PersonView | null;
    commits: { sha: string; title: string; author: string; url?: string }[];
    total: number;
    compareUrl: string | null;
    created: boolean;
    deleted: boolean;
}

export function renderPushCard(v: PushView, opts: RenderOpts): OutPost & { channel_id: '' } {
    const verb = v.deleted ? 'deleted branch' : v.created ? 'created branch' : `pushed ${v.total} commit${v.total === 1 ? '' : 's'} to`;
    const message = `📤 **${v.pusher?.mention ?? 'Someone'}** ${verb} ${code(v.branch)} in ${link(v.projectPath, v.projectUrl)}`;
    const rows = v.commits.slice(0, 8).map((c) => [c.url ? link(code(shortSha(c.sha)), c.url) : code(shortSha(c.sha)), truncate(firstLine(c.title), 90), c.author]);
    const more = v.total > rows.length ? `\n_…and ${v.total - rows.length} more commits${v.compareUrl ? ` — ${link('compare', v.compareUrl)}` : ''}_` : '';
    const att: MmAttachment = {
        fallback: `${v.total} commits pushed to ${v.branch}`,
        color: '#6b7280',
        text: rows.length ? table(['Commit', 'Message', 'Author'], rows) + more : '',
        footer: v.projectPath,
    };
    return { channel_id: '', message, props: rows.length ? { attachments: [att] } : {} };
}

export function renderSimpleCard(input: { emoji: string; headline: string; title?: string; titleLink?: string; rows: [string, string | null | undefined][]; color: string; footer?: string; quote?: string | null }, btns: ButtonSpec[], opts: RenderOpts): OutPost & { channel_id: '' } {
    const att: MmAttachment = {
        fallback: input.headline.replace(/[*_`[\]()]/g, ''),
        color: input.color,
        text: [kvTable(input.rows), input.quote ? `> ${truncate(cleanMessageBody(input.quote).replace(/\n+/g, ' '), 300)}` : ''].filter(Boolean).join('\n\n'),
    };
    if (input.title) att.title = input.title;
    if (input.titleLink) att.title_link = input.titleLink;
    if (input.footer) att.footer = input.footer;
    if (btns.length) att.actions = buttons(opts, btns);
    return { channel_id: '', message: `${input.emoji} ${input.headline}`, props: { attachments: [att] } };
}

export function renderLogPost(input: { jobName: string; jobUrl: string; stage: string; reason: string | null; lines: number; truncated: boolean; log: string; fileNote: string | null }): string {
    const header = `🔎 **Failed job** ${link(input.jobName, input.jobUrl)} · stage ${code(input.stage)}${input.reason ? ` · ${input.reason.replace(/_/g, ' ')}` : ''}`;
    const body = '```\n' + input.log.replace(/```/g, "'''") + '\n```';
    const note = input.truncated ? `\n_Showing the last ${input.lines} lines${input.fileNote ? ` — ${input.fileNote}` : ''}._` : '';
    return `${header}\n${body}${note}`;
}

export { mdCell };
