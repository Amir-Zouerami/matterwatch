# Security model

- **Webhooks:** constant-time check of `X-Gitlab-Token`; body ≤ 5 MB; stored raw (purged after 14 days). With no secret configured the endpoint answers `503`.
- **Buttons:** contexts are HMAC-signed and the callback URL carries a secret key. Write actions need a linked GitLab user or a Mattermost system admin (`actions.require_linked_user`) and are written to the audit log (`/gl audit`).
- **Slash command:** verified with the per-command token Mattermost issues at registration. Changing switches needs a Mattermost system admin. Self-linking only works if the GitLab public e-mail or username matches your Mattermost profile.
- **Logs posted to chat** pass through a masker: GitLab/GitHub/Slack/AWS tokens, JWTs, private keys, `Bearer …`, `password=…` pairs, URL credentials and anything in `MASK_LITERALS`.
- **Mention hygiene:** `@channel`, `@here` and `@user` inside text written by GitLab users (titles, comments, names) are defanged, so Matterwatch cannot be used to ping people.
- **Refusals are final:** a blocked bot or deleted channel (HTTP 400/403/404/405/410/422) is never retried in a loop.
- **Expose only** `/hooks/gitlab`, `/mm/actions`, `/mm/slash`, `/healthz`.
- The bot token is a **system-admin** token and the GitLab token is **Maintainer**: store both as secrets and rotate them if leaked.

Found a vulnerability? See [SECURITY.md](../SECURITY.md).
