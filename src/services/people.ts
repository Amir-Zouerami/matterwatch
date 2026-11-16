import type { App } from '../app.ts';
import type { PersonView } from '../render/cards.ts';
import type { LinkedUser } from '../domain/users.ts';
import type { OutPost } from '../mattermost/types.ts';
import { defang } from '../util/text.ts';
import { inQuietHours, localParts, nextLocalHour } from '../util/time.ts';
import { enqueueScheduled } from './scheduler.ts';

export interface GlPerson {
    username?: string | undefined;
    name?: string | undefined;
    email?: string | null | undefined;
    /** Extra addresses to try (commit author e-mail, …). */
    emails?: (string | null | undefined)[] | undefined;
}

export type DmKind = 'pipeline' | 'review' | 'comment' | 'state' | 'digest';

const DM_FEATURE: Record<DmKind, string> = {
    pipeline: 'dm.pipeline_result',
    review: 'dm.reviewer_assigned',
    comment: 'dm.mr_comment',
    state: 'dm.mr_state',
    digest: 'digest.stale_mr',
};

/** GitLab users we could not match to Mattermost, so an admin can see who still needs `/gl link`. */
function noteUnlinked(app: App, username: string): void {
    const m = app.settings.get<Record<string, { last: string; n: number }>>('unlinked', {});
    const k = username.toLowerCase();
    m[k] = { last: new Date().toISOString(), n: (m[k]?.n ?? 0) + 1 };
    const keys = Object.keys(m);
    if (keys.length > 200) delete m[keys.sort((a, b) => m[a]!.last.localeCompare(m[b]!.last))[0]!];
    app.settings.set('unlinked', m);
}

export function unlinkedUsers(app: App): { username: string; last: string; n: number }[] {
    const m = app.settings.get<Record<string, { last: string; n: number }>>('unlinked', {});
    return Object.entries(m)
        .filter(([u]) => !app.users.byGitlab(u))
        .map(([username, v]) => ({ username, ...v }))
        .sort((a, b) => b.n - a.n);
}

export async function linkedUser(app: App, p: GlPerson | null | undefined): Promise<LinkedUser | null> {
    if (!p?.username) return null;
    const u = await app.users
        .resolve(p.username, [p.email, ...(p.emails ?? [])], app.features.isEnabled('users.auto_link_email'), async () => (await app.gl.findUserByUsername(p.username!))?.public_email)
        .catch(() => null);
    if (!u && app.features.isEnabled('users.auto_link_email')) noteUnlinked(app, p.username);
    return u;
}

export async function personView(app: App, p: GlPerson | null | undefined): Promise<PersonView | null> {
    if (!p) return null;
    if (!p.username) {
        // e.g. a commit author we only know by name + e-mail
        for (const e of [p.email, ...(p.emails ?? [])]) {
            if (!e) continue;
            const mmUser = await app.mm.userByEmail(e).catch(() => null);
            if (mmUser && !mmUser.is_bot) return { gitlab: mmUser.username, mention: `@${mmUser.username}` };
        }
        return p.name ? { mention: defang(p.name), gitlab: defang(p.name) } : null;
    }
    const linked = await linkedUser(app, p);
    return { gitlab: p.username, mention: linked ? `@${linked.mm_username}` : defang(p.name || p.username) };
}

export async function peopleViews(app: App, list: GlPerson[] | undefined): Promise<PersonView[]> {
    const out: PersonView[] = [];
    for (const p of list ?? []) {
        const v = await personView(app, p);
        if (v) out.push(v);
    }
    return out;
}

function prefAllows(user: LinkedUser, kind: DmKind): boolean {
    const p = user.prefs;
    if (kind === 'pipeline') return p.dmPipelines !== false;
    if (kind === 'review') return p.dmReviews !== false;
    if (kind === 'comment') return p.dmComments !== false;
    if (kind === 'state') return p.dmState !== false;
    return true;
}

/**
 * Queue a direct message in the outbox (delivered right away, or held until morning during quiet hours),
 * honouring feature switches and personal prefs. `dedupe` makes re-processing the same event harmless.
 */
const DM_BLOCK_HOURS = 24;

/** Mattermost refused a DM to this user (blocked/deactivated/no DM allowed): pause DMs to them for a day. */
export function markDmBlocked(app: App, mmUserId: string): void {
    const m = app.settings.get<Record<string, string>>('dmBlocked', {});
    m[mmUserId] = new Date(Date.now() + DM_BLOCK_HOURS * 3_600_000).toISOString();
    app.settings.set('dmBlocked', m);
}

export function isDmBlocked(app: App, mmUserId: string): boolean {
    const until = app.settings.get<Record<string, string>>('dmBlocked', {})[mmUserId];
    return !!until && new Date(until).getTime() > Date.now();
}

export async function sendDm(app: App, user: LinkedUser, kind: DmKind, post: Omit<OutPost, 'channel_id'>, dedupe: string | null = null): Promise<'queued' | 'deferred' | 'skipped'> {
    const ctx = { userId: user.mm_user_id };
    if (!app.features.isEnabled(DM_FEATURE[kind], ctx) || !prefAllows(user, kind)) return 'skipped';
    if (user.mm_user_id === app.bot.id) return 'skipped';
    if (isDmBlocked(app, user.mm_user_id)) return 'skipped';

    let runAt = new Date();
    let deferred = false;
    const quiet = app.features.isEnabled('dm.quiet_hours', ctx) && user.prefs.quietHours !== false;
    if (quiet) {
        const hour = localParts(runAt, app.cfg.TZ_NAME).hour;
        if (inQuietHours(hour, app.cfg.QUIET_HOURS_START, app.cfg.QUIET_HOURS_END)) {
            runAt = nextLocalHour(runAt, app.cfg.QUIET_HOURS_END, app.cfg.TZ_NAME);
            deferred = true;
        }
    }
    enqueueScheduled(app, 'dm', { mmUserId: user.mm_user_id, post }, runAt, dedupe ? `${dedupe}:${user.mm_user_id}` : null);
    return deferred ? 'deferred' : 'queued';
}
