# Setup guide

About 10 minutes. You need: a Mattermost server, a GitLab (gitlab.com or self-managed), and a place to run one small container that both can reach.

## 1. Create the Mattermost bot

The bot needs to join channels, post, edit, DM people and register the `/gl` command, so it needs the **System Admin** role.

1. *System Console → Integrations → Bot Accounts*: enable bot accounts, then create a bot (e.g. `gitlab`). Give it the **System Admin** role.
2. Create a **token** for it and keep it as `MM_TOKEN`.
3. Add the bot to your team and note the **team name** (`MM_TEAM_NAME`) and the **channel id** of the channel that should receive cards (`MM_UPDATES_CHANNEL_ID`; channel menu → *View Info*, or the API).

> If your Mattermost version cannot create admin bots from the UI, create a normal user, then `mmctl user convert --bot <user>`.

## 2. Let Mattermost call Matterwatch

Buttons and `/gl` make **Mattermost call Matterwatch** at `SERVICE_URL`. If that is a private/internal address (a Docker service name, a LAN IP) Mattermost refuses it unless you allow it:

*System Console → Environment → Developer → Allow untrusted internal connections* (`ServiceSettings.AllowedUntrustedInternalConnections`) = the host of `SERVICE_URL`.

## 3. Create the GitLab token

A **group access token** (or project/personal token) with scope `api` and role **Maintainer**. It is used to read MRs/pipelines/job logs and to retry, cancel, approve and merge. For a read-only setup use `read_api` and switch the write buttons off.

## 4. Run Matterwatch

```sh
git clone https://github.com/Amir-Zouerami/matterwatch && cd matterwatch
cp .env.example .env      # fill in the required values
docker compose up -d --build
curl localhost:3000/healthz   # {"ok":true}
```

The SQLite database lives in the `matterwatch-data` volume. Run **one** instance only.

**Networking.** `MM_URL` must be reachable from the Matterwatch container, and `SERVICE_URL` from Mattermost. If Mattermost runs in another Docker Compose project, join its network (see the commented `networks` lines in `docker-compose.yml`) and use service names, e.g. `MM_URL=http://mattermost:8065` and `SERVICE_URL=http://matterwatch:3000`. Otherwise use the hosts' real addresses.

## 5. Expose the webhook (and only the webhook)

GitLab must reach Matterwatch over HTTPS. Proxy these paths to port 3000 and nothing else:

| Path | Why |
|---|---|
| `POST /hooks/gitlab` | GitLab webhooks |
| `POST /mm/actions` | Button clicks (if Mattermost reaches you through the proxy) |
| `POST /mm/slash` | `/gl` slash command |
| `GET /healthz` | Health check |

`/admin` and `/metrics` should stay internal. Example nginx:

```nginx
location ~ ^/(hooks/gitlab|mm/actions|mm/slash|healthz)$ {
    proxy_pass http://matterwatch:3000;
}
```

## 6. Register the webhooks

For one project: *Settings → Webhooks* → URL `https://matterwatch.example.com/hooks/gitlab`, secret token = `GITLAB_WEBHOOK_SECRET`, tick merge requests, pipelines (plus anything you switch on later).

For a whole group at once (idempotent; re-run for new projects):

```sh
GITLAB_URL=https://gitlab.example.com GITLAB_TOKEN=… GITLAB_WEBHOOK_SECRET=… \
HOOK_URL=https://matterwatch.example.com/hooks/gitlab \
node scripts/sync-webhooks.ts my-group --dry-run
```

The script is included in the image, so you can also run it from the container: `docker compose exec matterwatch node scripts/sync-webhooks.ts my-group --dry-run` (it reads `GITLAB_TOKEN` and `GITLAB_WEBHOOK_SECRET` from `.env`; pass `HOOK_URL` with `-e`).

## 7. Link your people

Everyone runs `/gl link <gitlab-username>` once. Matterwatch also links by matching e-mail or an identical username; `/gl unlinked` lists the GitLab users it has seen but could not match (admins fix them with `/gl link <gitlab-user> @mattermost-user`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Nothing posted | Project → *Settings → Webhooks → Recent events*: 401 = secret mismatch, 5xx = Matterwatch is down. Then `docker compose logs matterwatch`. |
| Buttons / `/gl` fail with an invalid-URL error | Step 2 (allow untrusted internal connections), or `SERVICE_URL` is not reachable from Mattermost. |
| A pasted link is ignored | The bot is not in that channel, `links.watch_mr` is off there, or the link's host differs from `GITLAB_URL`. |
| GitLab calls fail with 401/403/404 | Token expired, wrong scope, or the project is outside the token's group. |
| Logs/DMs missing | The `pipeline.failure_logs` / `dm.*` switch is off, or the token lacks `read_api`. `POST /admin/requeue` revives parked rows. |
