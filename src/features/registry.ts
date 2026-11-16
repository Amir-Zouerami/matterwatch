export interface FeatureDef {
    key: string;
    group: string;
    description: string;
    default: boolean;
}

const f = (key: string, group: string, description: string, def = true): FeatureDef => ({
    key,
    group,
    description,
    default: def,
});

/** Every behaviour of the service sits behind one of these switches. */
export const FEATURES: FeatureDef[] = [
    // Channel cards
    f('cards.merge_request', 'cards', 'Card when a merge request is opened/merged or a review is requested (later changes edit that card)'),
    f('cards.pipeline', 'cards', 'Card for every pipeline status change (one card per pipeline, edited in place)'),
    f('cards.pipeline_running', 'cards', 'Also create the card when a pipeline starts (off = card appears at the first finished state)'),
    f('cards.push', 'cards', 'Post a card for pushes (commit table)', false),
    f('cards.tag', 'cards', 'Post a card for tag pushes', false),
    f('cards.issue', 'cards', 'Post a card for issue events', false),
    f('cards.comment', 'cards', 'Post MR/issue comments (as thread replies when a card exists)', false),
    f('cards.deployment', 'cards', 'Post a card for deployment events', false),
    f('cards.release', 'cards', 'Post a card for releases', false),
    f('cards.update_in_place', 'cards', 'Edit one card per MR/pipeline instead of posting a new message per state'),
    f('cards.threads', 'cards', 'Group follow-up messages (logs, comments) in a thread under the card'),
    f('cards.mr_ci_status', 'cards', 'Keep the pipeline line and merge button of an open MR card in sync with its latest pipeline'),
    f('cards.reactions', 'cards', 'Add status reactions to MR cards (approved, merged, closed)'),
    f('cards.conventional_commits', 'cards', 'Parse type(scope): subject titles into tags'),
    f('cards.jalali_dates', 'cards', 'Show Persian (Jalali) calendar dates on cards instead of Gregorian'),

    // People
    f('mentions.channel', 'people', 'Mention relevant people (author, reviewers, assignees) in channel cards'),
    f('dm.pipeline_result', 'people', 'DM the author when their pipeline finishes'),
    f('dm.pipeline_failures_only', 'people', 'Limit pipeline DMs to failures', false),
    f('dm.reviewer_assigned', 'people', 'DM a person when they are assigned as reviewer/assignee'),
    f('dm.mr_comment', 'people', 'DM the MR author when someone comments', false),
    f('dm.mr_state', 'people', 'DM the author when their MR is approved, merged or closed', false),
    f('dm.quiet_hours', 'people', 'Hold DMs during quiet hours and deliver them in the morning'),

    // Pipelines
    f('pipeline.failure_logs', 'pipelines', 'Post the failed job log when a pipeline fails'),
    f('pipeline.log_file', 'pipelines', 'Attach the full log as a file when it is longer than the tail'),
    f('pipeline.mask_secrets', 'pipelines', 'Mask tokens/passwords in posted logs (turn off only for debugging)'),
    f('pipeline.merge_follow', 'pipelines', 'After an MR is merged, follow the resulting pipeline on the target branch'),
    f('pipeline.poller', 'pipelines', 'Poll GitLab for active watches when webhooks are missing'),

    // Link watching
    f('links.watch_mr', 'links', 'Watch MR links pasted in channels and report the pipeline outcome there'),
    f('links.watch_pipeline', 'links', 'Watch pipeline links pasted in channels'),
    f('links.react', 'links', 'React to a watched link message (eyes / result)'),
    f('links.mention_poster', 'links', 'Mention the person who pasted the link when the result arrives'),

    // Interactive actions (write access to GitLab)
    f('actions.retry', 'actions', 'Button: retry a failed pipeline'),
    f('actions.cancel', 'actions', 'Button: cancel a running pipeline'),
    f('actions.merge', 'actions', 'Button: merge when pipeline succeeds'),
    f('actions.approve', 'actions', 'Button: approve a merge request'),
    f('actions.logs', 'actions', 'Button: show failed job logs'),
    f('actions.watch', 'actions', 'Button: watch this pipeline/MR in the current channel'),
    f('actions.require_linked_user', 'actions', 'Only linked GitLab users or admins may press write buttons'),

    // Digests
    f('digest.daily', 'digests', 'Post the daily digest (open MRs, failures)', false),
    f('digest.stale_mr', 'digests', 'Remind reviewers about MRs waiting for review', false),
    f('digest.weekly', 'digests', 'Post the weekly merge summary', false),

    // Commands & plumbing
    f('slash.commands', 'plumbing', 'Enable the /gl slash command'),
    f('users.auto_link_email', 'plumbing', 'Link GitLab users to Mattermost users automatically by email'),
    f('filters.ignore_bots', 'plumbing', 'Ignore events from bot users listed in IGNORE_USERS'),
    f('routing.per_project', 'plumbing', 'Allow per-project mute and channel routing'),
];

export const FEATURE_KEYS = new Set(FEATURES.map((x) => x.key));
export const featureByKey = (key: string): FeatureDef | undefined => FEATURES.find((x) => x.key === key);
