# Features & switches

Every behaviour is a switch that can be flipped live, with no restart. Resolution order, most specific wins: **user › channel › project › global › default**. Keys are defined in [`src/features/registry.ts`](../src/features/registry.ts).

```
/gl features                              list (as seen in the current channel)
/gl features off dm.*                     a whole group, globally
/gl features off links.watch_mr here      only in the current channel
/gl features on cards.comment project my-group/my-project
/gl features reset links.watch_mr here    drop the override
```

HTTP alternative (from the server / docker network only — `/admin` is **not** exposed publicly):

```sh
docker compose exec matterwatch wget -qO- --header "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:3000/admin/features
```


**cards**

| Key | Default | What it does |
|---|:-:|---|
| `cards.merge_request` | on | Card when a merge request is opened/merged or a review is requested (later changes edit that card) |
| `cards.pipeline` | on | Card for every pipeline status change (one card per pipeline, edited in place) |
| `cards.pipeline_running` | on | Also create the card when a pipeline starts (off = card appears at the first finished state) |
| `cards.push` | off | Post a card for pushes (commit table) |
| `cards.tag` | off | Post a card for tag pushes |
| `cards.issue` | off | Post a card for issue events |
| `cards.comment` | off | Post MR/issue comments (as thread replies when a card exists) |
| `cards.deployment` | off | Post a card for deployment events |
| `cards.release` | off | Post a card for releases |
| `cards.update_in_place` | on | Edit one card per MR/pipeline instead of posting a new message per state |
| `cards.threads` | on | Group follow-up messages (logs, comments) in a thread under the card |
| `cards.mr_ci_status` | on | Keep the pipeline line and merge button of an open MR card in sync with its latest pipeline |
| `cards.reactions` | on | Add status reactions to MR cards (approved, merged, closed) |
| `cards.conventional_commits` | on | Parse type(scope): subject titles into tags |
| `cards.jalali_dates` | off | Show Persian (Jalali) calendar dates instead of Gregorian |

**people**

| Key | Default | What it does |
|---|:-:|---|
| `mentions.channel` | on | Mention relevant people (author, reviewers, assignees) in channel cards |
| `dm.pipeline_result` | on | DM the author when their pipeline finishes |
| `dm.pipeline_failures_only` | off | Limit pipeline DMs to failures |
| `dm.reviewer_assigned` | on | DM a person when they are assigned as reviewer/assignee |
| `dm.mr_comment` | off | DM the MR author when someone comments |
| `dm.mr_state` | off | DM the author when their MR is approved, merged or closed |
| `dm.quiet_hours` | on | Hold DMs during quiet hours and deliver them in the morning |

**pipelines**

| Key | Default | What it does |
|---|:-:|---|
| `pipeline.failure_logs` | on | Post the failed job log when a pipeline fails |
| `pipeline.log_file` | on | Attach the full log as a file when it is longer than the tail |
| `pipeline.mask_secrets` | on | Mask tokens/passwords in posted logs (turn off only for debugging) |
| `pipeline.merge_follow` | on | After an MR is merged, follow the resulting pipeline on the target branch |
| `pipeline.poller` | on | Poll GitLab for active watches when webhooks are missing |

**links**

| Key | Default | What it does |
|---|:-:|---|
| `links.watch_mr` | on | Watch MR links pasted in channels and report the pipeline outcome there |
| `links.watch_pipeline` | on | Watch pipeline links pasted in channels |
| `links.react` | on | React to a watched link message (eyes / result) |
| `links.mention_poster` | on | Mention the person who pasted the link when the result arrives |

**actions**

| Key | Default | What it does |
|---|:-:|---|
| `actions.retry` | on | Button: retry a failed pipeline |
| `actions.cancel` | on | Button: cancel a running pipeline |
| `actions.merge` | on | Button: merge when pipeline succeeds |
| `actions.approve` | on | Button: approve a merge request |
| `actions.logs` | on | Button: show failed job logs |
| `actions.watch` | on | Button: watch this pipeline/MR in the current channel |
| `actions.require_linked_user` | on | Only linked GitLab users or admins may press write buttons |

**digests**

| Key | Default | What it does |
|---|:-:|---|
| `digest.daily` | off | Post the daily digest (open MRs, failures) |
| `digest.stale_mr` | off | Remind reviewers about MRs waiting for review |
| `digest.weekly` | off | Post the weekly merge summary |

**plumbing**

| Key | Default | What it does |
|---|:-:|---|
| `slash.commands` | on | Enable the /gl slash command |
| `users.auto_link_email` | on | Link GitLab users to Mattermost users automatically by email |
| `filters.ignore_bots` | on | Ignore events from bot users listed in IGNORE_USERS |
| `routing.per_project` | on | Allow per-project mute and channel routing |
