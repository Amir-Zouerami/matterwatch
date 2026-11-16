# Configuration reference

Environment variables, validated with zod in [`src/config.ts`](../src/config.ts). Copy [`.env.example`](../.env.example) to `.env`.

## Required

| Variable | What |
|---|---|
| `MM_TOKEN` | Access token of the Mattermost bot account |
| `MM_TEAM_NAME` | Team where the `/gl` slash command is registered |
| `MM_UPDATES_CHANNEL_ID` | Channel id that receives the cards |
| `GITLAB_TOKEN` | GitLab access token (scope `api` for buttons; `read_api` for read-only) |
| `GITLAB_WEBHOOK_SECRET` | Shared secret sent by GitLab in `X-Gitlab-Token` |

## Recommended

| Variable | Default | Meaning |
|---|---|---|
| `GITLAB_URL` | `https://gitlab.com` | GitLab base URL (also what link detection matches) |
| `MM_URL` | `http://localhost:8065` | Mattermost address **as Matterwatch can reach it** (e.g. `http://mattermost:8065` in Docker) |
| `SERVICE_URL` | `http://localhost:3000` | How **Mattermost** reaches Matterwatch for buttons and `/gl` |
| `ACTION_SIGNING_SECRET` | webhook secret | HMAC key for button contexts |
| `TZ_NAME` | `UTC` | Timezone for dates, quiet hours, digests |

## Optional

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_TOKEN` | *(off)* | Bearer token that enables `/admin/*` |
| `METRICS_TOKEN` | *(off)* | Bearer token for `/metrics` |
| `MM_WATCH_CHANNEL_IDS` | *(empty)* | Extra channels the bot joins (comma list) |
| `MM_SLASH_TRIGGER` | `gl` | Slash command trigger |
| `MM_SLASH_TOKEN` | *(auto)* | Filled automatically when the command is registered |
| `DB_PATH` | `/data/service.sqlite` (container) | SQLite file |
| `PORT` | `3000` | HTTP port |
| `QUIET_HOURS_START` / `_END` | `23` / `8` | DMs are held in this window (set equal to disable) |
| `FAILURE_LOG_LINES` / `FAILURE_LOG_MAX_JOBS` | `40` / `3` | Log tail size / jobs per pipeline |
| `WATCH_TTL_HOURS` | `72` | Idle watches expire |
| `POLL_INTERVAL_SECONDS` | `45` | Watch poller interval (fallback when a webhook is missing) |
| `DIGEST_HOUR` / `STALE_MR_HOURS` | `9` / `24` | Digest hour; "waiting for review" threshold |
| `IGNORE_USERS` | *(empty)* | Comma list of bot usernames (used when `filters.ignore_bots` is on) |
| `MASK_LITERALS` | *(empty)* | Extra literal strings to mask in posted logs |
| `ENABLE_SOCKET` / `ENABLE_POLLER` / `ENABLE_SCHEDULER` / `ENABLE_SETUP` | `true` | Kill-switches for the websocket listener, poller, timers, and startup setup |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` (JSON lines on stdout/stderr) |
