# Architecture

```
GitLab ──webhook──▶ POST /hooks/gitlab
                      │ verify X-Gitlab-Token, persist raw delivery (SQLite inbox, de-duplicated)
                      ▼
                inbound_events ──worker (one at a time, retry w/ backoff, dead after 20)──▶ handlers
                                                                                           │
        ┌──────────────────────────────────────────────────────────────────────────────────┤
        ▼                         ▼                          ▼                             ▼
  channel cards            DMs (quiet hours →         failure logs (thread)       watches (link/merge
  (create/edit in place)   scheduled table)           + masked, tailed            follow) → pipeline result
        │                         │                          │                             │
        └────────────── Mattermost REST (bot token) ◀────────┴─────────────────────────────┘

Mattermost ──WebSocket "posted"──▶ link detector ──▶ GitLab API ──▶ watch + thread reply
Mattermost ──button click──▶ POST /mm/actions?k=… (signed context) ──▶ GitLab API (retry/cancel/approve/merge/logs)
Mattermost ──/gl …──▶ POST /mm/slash (token) ──▶ features, watch, link, mrs, logs, …
timers: inbound drain (5 s) · outbox (5 s) · digest check (60 s) · watch poller (45 s) · channel membership (1 h) · purge (6 h)
```

Key design points

* **Inbox first.** A webhook is stored in SQLite *before* we answer `202`, so a Mattermost outage or crash never loses an event. Duplicate deliveries (GitLab retries) are ignored via `X-Gitlab-Event-UUID`. Failed processing is retried with exponential backoff (20 tries ≈ 4½ h, then `dead`; revive with `POST /admin/requeue`).
* **Outbox for side effects.** DMs, thread pings and failure logs are *not* sent inline: they are written to the `scheduled` table (the outbox) with a **dedupe key** derived from the inbox event, then delivered by a worker (5 s tick + right after each event) with retries (12 tries). Re-processing the same event can therefore neither lose nor duplicate them. Quiet-hours DMs are just outbox rows with a later `run_at`.
* **No endless retries.** Transient errors (5xx, 429, timeouts) are retried with backoff; *refusals that cannot fix themselves* (HTTP 400/403/404/405/410/422 — e.g. a user blocked or deactivated the bot, a channel was deleted) are not: a refused DM is parked immediately and DMs to that user pause for 24 h, a refused inbox event gets 3 tries instead of 20.
* **Stale-event guard.** Each card remembers the inbox sequence that last wrote it; an older, retried event can never move a card backwards.
* **No missed links.** The WebSocket cursor per watched channel is stored; after every (re)connect/deploy the bot replays messages it missed (`catchUp`). Edited messages (`post_edited`) are handled too. The bot also re-joins its channels hourly if it was removed.
* **Bounded memory.** Job logs are streamed and only the last 512 KB is kept, even if GitLab ignores the `Range` header.
* **Mention hygiene.** `@channel` / `@here` / `@user` in anything written by GitLab users (comments, titles, display names) is defanged, so the bot can't be used to ping people.
* **One card per thing, edited in place.** MR cards and pipeline cards are created once and then *patched* as state changes (table `cards`). Edits never notify, so pings are sent as separate thread replies/DMs.
* **Stable ids.** Everything is keyed by GitLab *project id* (not path), so moving/renaming projects between groups does not break watches or cards.
* **Idempotent & serialised.** Per-card/per-watch async locks avoid duplicate cards when a webhook and the poller race.
* **No build step.** Node 24 strips TypeScript types at runtime (`node src/index.ts`). Keep TS "erasable": no `enum`, no constructor parameter properties.
* **SQLite** via the built-in `node:sqlite`: WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout`, append-only migrations, `BEGIN IMMEDIATE` transactions. Single process only (do not scale to >1 replica).

## Data model (SQLite)

Migrations are append-only in [`src/db/migrations.ts`](src/db/migrations.ts). Tables (all `STRICT`):

| Table | Purpose |
|---|---|
| `features`, `feature_overrides` | Global switch values; per channel / project / user overrides |
| `settings` | Small key/value JSON |
| `users` | GitLab username ⇄ Mattermost user (`source` = email/username match or manual) + DM preferences |
| `inbound_events` | Webhook inbox: raw payload, `delivery_key` (unique), status `pending/done/dead`, attempts, next try |
| `cards` | One row per posted card: (kind, project id, ref, channel) → Mattermost post id, last state, `seq` of the inbox event that wrote it |
| `watches` | Link/merge watches: project, MR iid or pipeline id, channel, root post, last pipeline, merge sha, TTL |
| `scheduled` | **The outbox**: DMs, thread posts, failure-log jobs; `dedupe_key` (unique) makes enqueue idempotent; also holds quiet-hours DMs |
| `projects` | Project id ⇄ path, `muted`, per-project channel override |
| `audit_log` | Who pressed which button / changed which switch |
| `once` | "Do this at most once" markers (daily digest, stale reminders) |
| `schema_migrations` | Applied migrations |

Housekeeping (every 6 h): finished inbox/scheduled rows >14 d, audit >90 d, cards >60 d are purged; expired watches are closed.

## Code map

```
src/
  index.ts              bootstrap: config → DB → clients → setup (join team/channels, register /gl) → websocket, timers, HTTP
  config.ts             env parsing (zod) and defaults
  app.ts                the App context passed to every service (db, clients, stores, features, bot)
  db/                   openDb (WAL, pragmas), tx(), append-only migrations
  features/             registry (all switches) + resolver (user>channel>project>global>default)
  gitlab/               client (REST, retries), events (zod schemas, parseEvent)
  mattermost/           client (REST), socket (WebSocket + reconnect), sign (HMAC, endpoint key), types
  render/               cards.ts (MR / pipeline / push / simple cards, jobs table), theme.ts, table.ts
  domain/               stores (cards, watches, settings, projects, audit, once), users (link + prefs)
  services/
    ingest.ts           inbox accept + serial worker with retries
    handlers.ts         event → card / DMs / watches (the channel policy lives here)
    watch.ts            link detection, watch sync, merge-follow, poller
    failure-logs.ts     fetch + mask + tail job logs, post in thread
    people.ts           mentions, linked users, DMs with quiet hours
    scheduler.ts        delayed deliveries, housekeeping
    actions.ts          button callbacks    slash.ts  /gl    digest.ts  digests
  http/app.ts           Hono routes
  util/                 text (masking, conventional commits), time (Jalali/local, quiet hours), urls, lock, async
scripts/sync-webhooks.ts   register webhooks for a whole group
test/                      unit + flow tests with fakes
```
