# Operations

```sh
docker compose ps                    # should be (healthy)
docker compose logs --tail 50 matterwatch # JSON lines
curl localhost:3000/readyz           # also reports the websocket state
```

| Endpoint | Public? | Auth | Purpose |
|---|:-:|---|---|
| `POST /hooks/gitlab` | ✅ | `X-Gitlab-Token` | Webhook receiver (answers `202` after storing) |
| `POST /mm/actions?k=…` | ✅ | endpoint key + signed context | Button callbacks |
| `POST /mm/slash` | ✅ | slash token | `/gl` |
| `GET /healthz` | ✅ | – | Liveness |
| `GET /readyz` | ❌ | – | Liveness + websocket |
| `GET /metrics` | ❌ | `METRICS_TOKEN` | Prometheus text (`gitlab_mm_*`) |
| `GET/PUT /admin/features`, `GET /admin/status`, `GET /admin/audit`, `POST /admin/requeue` | ❌ | `ADMIN_TOKEN` | JSON admin API |

- **Quiet down instantly:** `/gl features off <key|group.*|all>`; `/gl features on …` restores.
- **After an outage:** events and outbox rows retry on their own for hours. Parked (`dead`) rows come back with `POST /admin/requeue`.
- **Rotate a secret:** change the variable, restart. For the webhook secret also re-run `sync-webhooks`.
- **Backup:** the database is small and rebuildable (cards would be re-created; watches, links and overrides would be lost). Use `sqlite3 .backup` or copy the file with its `-wal`/`-shm`.
- **Retention:** every 6 h finished inbox/outbox rows >14 d, audit >90 d and cards >60 d are purged.
- **Disable:** stop the container. GitLab retries deliveries and the data stays.
