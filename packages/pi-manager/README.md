# @pi-bots/pi-manager

Bot lifecycle for the service: creates, reads, updates, archives and deletes
bot agent dirs under `$PI_BOTS_HOME` (default `~/Bots`), and keeps their
service-owned invariants true. One writer; the bridge and the `pi-bot` CLI
both route through this package.

## API

```ts
import {
  createBot, readBot, listBots, updateBot, archiveBot, unarchiveBot, deleteBot,
  ensureInvariants, writeAdminSettings,
} from "@pi-bots/pi-manager";

await createBot({ name, packages?, thinking? });
readBot(name);       // { name, dir, archived, setup, packages, model, thinking? }
listBots({ includeArchived? }); // [{ name, dir, archived, setup }]
await updateBot(name, { packages?, thinking? });
archiveBot(name); unarchiveBot(name);
deleteBot(name, { confirm: name });
await ensureInvariants(name);   // the reconciler
```

`model` is the service-enforced model (`PI_BOT_MODEL`, default
`opencode-go/deepseek-v4.1-flash`); a bot cannot change it. `thinking` is one
of `off, minimal, low, medium, high, xhigh, max`. `setup` is true while the
agent has not yet committed its `init` commit.

## Scaffold

`create` writes `SOUL.md` and `BEHAVIOR.md` from `templates/` (plain files
both sides edit — no managed block), `settings.json` (inherits the shared
agent settings, then sets `defaultTools` to the tool floor and `packages` to
the base package), `.gitignore`, `.setup`, `skills/`, `extensions/`, `notes/`,
`sessions/`, symlinks to the shared agent dir (`auth.json`, `models.json`,
`models-store.json`, `trust.json`), and a git repo with a `Scaffold <name>`
commit. Then it installs the post-commit hook and runs the reconciler.

Updates merge the given settings fields and commit path-scoped
(`config: <what changed>`). Archive writes a gitignored `<bot>/.archived`
marker in place (the caller stops the server first); attach refuses archived
bots until unarchive. Delete needs `{ confirm: "<name>" }`.

## Commit → apply

Each bot repo gets a `post-commit` hook (`hooks.ts`):

- while `.setup` exists, only a commit titled exactly `init` applies — it
  removes `.setup` and writes `.apply`;
- afterwards, a commit touching `SOUL.md`, `BEHAVIOR.md`, `settings.json`,
  `skills/` or `extensions/` writes `.apply`;
- notes-only commits never do.

`.apply` is consumed by the connector (`applyPendingReload`): it stops the
server, runs the reconciler, clears the marker. The next attach starts a
fresh server from the new files.

## Reconciler (`ensureInvariants`)

Idempotent, runs on create, on `.apply`, and on
`POST /api/bots/:name/reload`:

- writes `SOUL.md` / `BEHAVIOR.md` when missing;
- installs the post-commit hook;
- regenerates the admin settings file;
- ensures every package declared in `settings.json` or the admin layer is
  installed (local sources just have to exist).

## Admin settings

`writeAdminSettings` materializes `<bot>/.admin-settings.json` (gitignored);
the launcher points the server at it with `PI_ADMIN_SETTINGS`. The fork merges
it after global + project settings: model wins, `packages` union, `defaultTools`
union floor, everything else agent-controlled.

| environment | default | meaning |
|---|---|---|
| `PI_BOT_MODEL` | `opencode-go/deepseek-v4.1-flash` | `provider/model` the admin layer enforces |
| `PI_BOT_PACKAGES` | — | extra mandatory package sources, comma-separated |

## Environment

| variable | default | meaning |
|---|---|---|
| `PI_BOTS_HOME` | `~/Bots` | bot directories |
| `PI_SHARED_AGENT_DIR` | `~/.pi/agent` | shared auth/models/trust files |

## Tests

```sh
node --test test/*.test.ts
```

Tests use temp roots (no network) and local directories as package sources —
including the hook and reconciler paths.
