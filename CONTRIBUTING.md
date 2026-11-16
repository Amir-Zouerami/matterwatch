# Contributing

Thanks for helping! The project is small on purpose: Node 24, Hono, built-in SQLite, no build step.

```sh
npm ci
npm run typecheck && npm test      # offline: Mattermost and GitLab are faked
cp .env.example .env && node --env-file=.env src/index.ts
```

## Rules of the road

- TypeScript must stay **erasable**: Node runs `.ts` directly, so no `enum`, no constructor parameter properties, `.ts` suffix on imports.
- Keep Mattermost and GitLab behind the `MattermostApi` / `GitlabApi` interfaces so tests never touch the network.
- Every behaviour gets a feature switch and a test (`test/helpers.ts` has `FakeMm` and `FakeGl`).
- Side effects (DMs, pings, logs) go through the outbox with a dedupe key, so reprocessing an event never duplicates them.
- Never retry a permanent refusal (400/403/404/405/410/422).

## Recipes

| I want to… | Touch |
|---|---|
| add a feature switch | `src/features/registry.ts`, guard with `app.features.isEnabled(key, ctx)`, add a test, document it in `docs/features.md` |
| handle a new GitLab event | zod schema in `src/gitlab/events.ts`, handler + route in `src/services/handlers.ts`, event list in `scripts/sync-webhooks.ts` |
| add a `/gl` subcommand | `src/services/slash.ts` (and its help text) |
| add a button | `ButtonSpec` in `src/services/handlers.ts`, implementation in `src/services/actions.ts`, a feature key |

Open an issue first for anything big. Commit messages: short imperative subject (`fix: …`, `feat: …`).
