# Changelog

## 1.0.0

First public release.

- Cards for merge requests and pipelines, edited in place; quiet by default.
- Failed-job logs with secrets masked; buttons for retry, cancel, approve, merge and show logs. Button results are always replies to the card.
- Link watching: paste an MR or pipeline URL and get the result in the thread.
- Direct messages with quiet hours; `/gl` slash command; per-user, channel and project feature switches (45).
- SQLite inbox and outbox with dedupe keys, stale-event guard, websocket catch-up, no retry loops on permanent refusals.
