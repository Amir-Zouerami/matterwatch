<div align="center">

# Matterwatch

**GitLab notifications your team will actually read.**
Cards that update in place, failed-job logs in the thread, one-click retry and merge, and a DM when *your* pipeline finishes.

[![CI](https://github.com/Amir-Zouerami/matterwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/Amir-Zouerami/matterwatch/actions)
![node](https://img.shields.io/badge/node-%E2%89%A524-3c873a)
![license](https://img.shields.io/badge/license-MIT-blue)
![deps](https://img.shields.io/badge/runtime%20deps-3-brightgreen)

</div>

The official Mattermost GitLab plugin posts one message for every event, so a busy channel turns into a wall of noise. Matterwatch is the opposite: **one card per merge request and per pipeline, edited as things change**, and almost nothing else.

```
❌ Pipeline #2310304 failed on MR !822 — @alice
┌─────────────────┬───────────────────────────────────────────────┐
│ Project         │ acme/shop-frontend                            │
│ Merge request   │ !822 feat(hero): add hero section             │
│ Author          │ @alice                                        │
│ Duration        │ 2m 5s                                         │
└─────────────────┴───────────────────────────────────────────────┘
Failed: unit-tests
  test   unit-tests   ❌ failed    1m 0s
  build  build        ✅ success   40s
  [ 🔁 Retry ]  [ 🔎 Show logs ]
  └─ reply: last 40 lines of `unit-tests`, secrets masked, full log attached
```

## Why you might want it

- **Quiet by default.** The channel gets merge requests (opened, reopened, merged, review requested) and pipeline status changes, nothing more. Pushes, tags, issues, comments, deployments and releases are one switch away.
- **One living card, not a stream.** MR and pipeline cards are created once and patched in place. An MR card follows its latest pipeline and loses its buttons when merged.
- **Paste a link, get the result.** Drop an MR or pipeline URL in any channel the bot is in. It watches the pipeline, replies in the thread, swaps 👀 for ✅ or ❌, and follows the MR through the merge.
- **Failures explained.** Failed jobs post their log tail in the thread: ANSI stripped, tokens and passwords masked, the full log attached when it is long.
- **ChatOps buttons.** Retry, cancel, approve, merge (or merge when green), show logs. Results are always replies to the card. Write actions need a linked GitLab account and are audited.
- **Talks to the right person.** It names and pings the *code author* as well as whoever triggered the pipeline, DMs both, and holds DMs during quiet hours.
- **Everything is a switch.** 45 live switches, resolved user › channel › project › global, flipped with `/gl features` — no redeploy.
- **Hard to break.** Webhooks land in a SQLite inbox before we answer, side effects go through a deduplicated outbox, stale retries can't move a card backwards, missed messages are replayed after a restart, and a blocked bot is never retried in a loop.
- **Tiny.** Node 24 running TypeScript directly (no build), [Hono](https://hono.dev), built-in `node:sqlite`, and `zod`. Three runtime dependencies. Runs happily in 256 MB.

## Quick start

```sh
git clone https://github.com/Amir-Zouerami/matterwatch && cd matterwatch
cp .env.example .env        # tokens, team and channel
docker compose up -d --build
```

Then point a GitLab webhook at `https://<your-host>/hooks/gitlab` and run `/gl link <your-gitlab-username>` in Mattermost. The [setup guide](docs/setup.md) walks through the bot, the tokens, the reverse proxy and the webhooks (one project or a whole group).

You need: a Mattermost bot with the System Admin role, a GitLab token with the `api` scope, and a single container reachable by both.

## Using it

| Command | What it does |
|---|---|
| `/gl link <gitlab-user>` | Connect your accounts (enables mentions, DMs, buttons) |
| `/gl watch <MR or pipeline URL>` | Report that pipeline's result in this channel |
| `/gl mrs [mine\|reviewing]` | Your open MRs, or those waiting on you |
| `/gl logs <pipeline URL>` | Failed-job logs of any pipeline |
| `/gl prefs <pipelines\|reviews\|comments\|state\|quiet\|failures-only> <on\|off>` | Your DM settings |
| `/gl features [on\|off\|reset] <key\|group.*\|all> [here\|project <path>]` | Switches (admins) |
| `/gl unlinked` · `/gl links` · `/gl audit` · `/gl digest` | Admin tools |

Silence something right now: `/gl features off cards.pipeline here`. Make the whole thing quiet: `/gl features off all`.

## Documentation

| | |
|---|---|
| [Setup guide](docs/setup.md) | Bot, tokens, proxy, webhooks, troubleshooting |
| [Features & switches](docs/features.md) | All 45 switches and what the default channel policy is |
| [Configuration](docs/configuration.md) | Every environment variable |
| [Operations](docs/operations.md) | Endpoints, metrics, backups, outages |
| [Architecture](docs/architecture.md) | Inbox/outbox design, data model, code map |
| [Security](docs/security.md) | Threat model and what is exposed |

## Architecture in 30 seconds

```
GitLab ──webhook──▶ /hooks/gitlab ──▶ SQLite inbox ──▶ handlers ──▶ cards · DMs · logs · watches
                                                           │
Mattermost ◀── REST (bot token) ◀── outbox (deduplicated, retried) ◀┘
Mattermost ──websocket──▶ link detector        Mattermost ──button / /gl──▶ signed callbacks ──▶ GitLab API
```

`src/` is split by responsibility: `gitlab/` and `mattermost/` are thin API clients behind interfaces, `render/` turns data into cards, `services/` holds the behaviour (ingest, handlers, watch, actions, slash, scheduler), `features/` the switch registry and resolver, `domain/` the stores. See [docs/architecture.md](docs/architecture.md).

## Development

```sh
npm ci
npm run typecheck && npm test     # 61 tests: fakes for Mattermost and GitLab
node --env-file=.env src/index.ts
```

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
