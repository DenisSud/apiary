# Architecture

How the service fits together: what runs where, which state lives where, and
what happens between creating an agent and talking to it. Per-package detail
stays in the package READMEs; this page is the map.

## Pieces

| piece | role | detail |
|---|---|---|
| `base/` (pi package: `extensions/`, `skills/`) | what every agent loads: security, sysinfo, memory; skill-authoring, self-config | this repo |
| `registry/` | packages an agent declares for itself (ptc, web-search, systemone; grilling, self-improvement, handoff) | `registry/README.md` |
| `packages/pi-manager/` | bot lifecycle: scaffold, read, update, archive, delete; reconciler; admin settings | its README |
| `packages/connector/` | bot registry, launcher, bridge, `pi-bot` CLI | its README |
| `packages/auth/` | provider login sessions over pi's `ModelRuntime` | its README |
| `packages/web/` | browser client served by the bridge | its README |
| `packages/systemone/` | System One client + shared config (Kev) | its README |
| `deploy/` | the per-user container image — the only supported runtime | `docs/container.md` |

An agent is a complete pi agent dir under `$PI_BOTS_HOME` (default `~/Bots`),
its own git repo. The service owns a small immutable layer around it: the
model, a tool floor and a set of mandatory packages (see
[self-configuration](self-config.md)).

## State

| state | location | owner |
|---|---|---|
| agent dir | `$PI_BOTS_HOME/<name>` | the agent (config surfaces) |
| shared agent dir | `PI_SHARED_AGENT_DIR` (`~/.pi/agent`): `auth.json`, `models.json`, `models-store.json`, `trust.json` | the service; symlinked into every agent dir |
| connector state | `PI_CONNECTOR_DIR` (`~/.pi/bots`): routes, locks, logs, session pointers | the connector |
| admin settings | `<bot>/.admin-settings.json` | the reconciler (read by the server as `PI_ADMIN_SETTINGS`) |
| markers | `<bot>/.setup`, `<bot>/.apply` | the post-commit hook and the connector |
| sessions | `<bot>/experimental/sessions/` | the pi server |

`.admin-settings.json`, `.setup` and `.apply` are gitignored; the shared
files are symlinks, not copies.

## The lifecycle

1. **Create** — `pi-bot new <name>` (or the API) scaffolds the agent dir and
   commits `Scaffold <name>`; `.setup` marks the agent as not yet configured.
2. **Setup** — the web client auto-sends `/skill:self-config`; the skill
   interviews the user, the agent edits SOUL.md, BEHAVIOR.md, `settings.json`
   and skills with normal tools, and commits exactly `init`. The hook clears
   `.setup` and writes `.apply`.
3. **Attach** — `pi-bot attach` or a web client resolves the bot: the pending
   apply runs (stop → reconciler → clear marker), the server is started from
   the pi checkout (`$PI_SOURCE_DIR`) if needed, and a session is attached
   over a unix socket.
4. **Config commits** — a commit touching `SOUL.md`, `BEHAVIOR.md`,
   `settings.json`, `skills/` or `extensions/` writes `.apply`; the bridge
   stops the server when it is idle, the reconciler runs, the next attach
   starts a fresh server. Notes-only commits never apply.
5. **Archive / delete** — archive stops the server and writes a gitignored
   `.archived` marker; attach refuses archived agents until unarchive. Delete
   removes the directory after `{ confirm: name }`.

## The admin layer

The fork merges `PI_ADMIN_SETTINGS` after global and project settings, on
startup, on `reload()`, and after every `set*` write:

| key | rule |
|---|---|
| `defaultProvider`, `defaultModel` | admin wins; `pi.models.select` is clamped, the picker is omitted |
| `packages` | union — mandatory packages always load |
| `defaultTools` | union floor `read`, `write`, `edit`, `bash`; extension tools are always active |
| everything else | agent-controlled |

The admin file is materialized by the reconciler; raw global and project
files are never rewritten with admin values. `PI_BOT_MODEL` and
`PI_BOT_PACKAGES` are the deployment knobs.

## Attach path

- **TUI:** `pi-bot attach <name>` → connector launcher → `runClient`.
- **Web:** browser WebSocket → bridge (`/ws?bot=<name>`) → the bot's unix
  socket; the bridge is an opaque byte relay plus a small JSON API
  (`/api/bots`, reload, auth proxy).
- **Watcher:** the bridge polls the apply markers (1s) and stops a bot's
  server when it is not relaying; a busy bot applies on its next attach.

## Boundaries

- The bridge is loopback-only until the container/auth work lands; the
  per-user container (`docs/container.md`) is the only supported runtime and
  the deployment boundary (devenv runs the service on the host for
  development only).
- Provider credentials and the model store live in the shared agent dir,
  written by the login flow, never by an agent.
- Integration credentials are reached through the `security` extension's
  secrets profiles, never from files or the environment.

## Where to read more

- Bot vs stock pi, surface by surface: `docs/self-config.md`.
- The container: `docs/container.md`.
- The memory system: `docs/memory.md`.
- Registry policy: `registry/README.md`.
