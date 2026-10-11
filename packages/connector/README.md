# @apiary/connector

The working core of the service: which bots exist, which session a bot should
open, where that choice is recorded, how a bot's server is started, and how
clients reach it. It also serves the web app and the HTTP API the app talks
to. No pi imports at the top — the launcher runs everything through the pi
checkout (`$PI_SOURCE_DIR`) as subprocesses, and the client/server handshake
enforces that the checkout and the installed `pi-client` match.

## CLI

```
apiary attach <bot> [--new]              ensure server, resolve session, run the client
apiary message <bot> <text...> [--new]   send a prompt, print the reply
apiary compact <bot> [--new]             compact the bot's session
apiary stop <bot>                        stop the bot's server
apiary resolve <bot> [--new]             ensure server, print the ref (TUI fork, --json)
apiary list [--json]                     list bots
apiary new <name>                        scaffold (pi-manager)
apiary <bot> [--new]                     sugar for attach
```

There is no `serve` verb: a bot runs only as a server.

## State

State root `$PI_CONNECTOR_DIR` (default `~/.pi/bots`), machine-local:

```
servers/             PI_SERVER_DIR shared by all bot servers
routes/<bot>.json    { serverId, socketPath, pid, startedAt }
sessions/<bot>.json  { serverId, sessionId, updatedAt }
locks/<bot>.lock
logs/<bot>.log
```

One file per bot per concern, so updates to different bots cannot overwrite
each other. Writes replace a file atomically (temp + rename); a reader sees
the old or the new file, never a torn one. Same-bot races are
last-write-wins — exactly the rule "the last attached session is the
default". Ordering comes from `rename()`, never from wall clocks.

## Guarantees

- Reads never throw: missing, malformed or botless state reads as "no
  pointer". A pointer to a session that no longer exists is not an error —
  attaching with that id creates the session, so stale pointers self-heal.
- New session, in order: generate id → record → attach. A crash between the
  two cannot create a second session; the retry materializes exactly that one.
- `recordAttached` is idempotent for the calling process; clients never cache
  the pointer, they read it at attach time.
- The pointer's `serverId` is informational: sessions live in the bot's agent
  dir, so a server restart does not invalidate them.

## Launcher

Per bot:

```
PI_SERVER_DIR  ~/.pi/bots/servers/<bot>
serverId       route's id if present, else a fresh uuid
socket         unix socket under the server dir
sessions       <bot>/experimental/sessions
spawn          node <pi checkout>/.../experimental/cli.ts server --server-id <id>
env            PI_EXPERIMENTAL=1 PI_CODING_AGENT_DIR=<bot> PI_SERVER_DIR=<dir>
               PI_BOT_NAME=<bot> PI_ADMIN_SETTINGS=<bot>/.admin-settings.json
               APIARY_REGISTRY_DIR=<registry dir>
```

Detached, `cwd` = bot dir, stdio to the log. `spawnServer` is a
`ServerSpawner` seam a later deployment can replace without touching the
state handling around it. Readiness is a real client handshake, retried with
a 10 s timeout; on timeout the child is killed and the log tail printed.

**Route and lock.** The route is written before the spawn (so a concurrent
launcher sees a pending route) and updated with pid after readiness. The
per-bot `O_EXCL` lock holds a pid; stale locks (dead pid, >30 s) are taken
over. It is held only across spawn and readiness.

**Attach.** `readRoute` → connect if alive → else take the lock, re-read,
spawn, wait, release → resolve session id (pointer, or fresh with `--new`) →
`recordAttached` → run the pi client with inherited stdio. `resolve` prints
`<bot>\t<sessionId>\t<socketPath>` or JSON.

**`stop`** verifies via `/proc/<pid>/environ` that the pid still belongs to
this bot's server, sends SIGTERM, escalates to SIGKILL after 3 s, clears the
route. **`compact`** runs the headless client with `--compact`.

## Bridge

`apiary-web` serves the app and the API (default `127.0.0.1:8787`):

| endpoint | what |
|---|---|
| `GET /api/bots` | `{name, dir, archived, setup, apply, running, serverId, pid, startedAt, lastSession}` from state files, never starting a server |
| `POST /api/bots` | `{name, packages?, thinking?}` → 201 detail (pi-manager) |
| `GET/PATCH /api/bots/:name` | detail; update `packages` / `thinking` |
| `POST /api/bots/:name/archive\|unarchive\|stop\|reload` | lifecycle; reload = stop + reconcile + clear apply marker |
| `DELETE /api/bots/:name` | `{confirm: "<name>"}` → 204 |
| `GET /api/auth/providers`, `POST /api/auth/login\|logout`, `WS /api/auth/login/:id` | provider login proxy (`packages/auth`) |
| `GET /ws?bot=<name>[&session=<uuid>]` | upgrade, then the bot server's byte stream |
| static | the built web app; missing build → 503 with the build command |

The relay is opaque: one WebSocket carries one session's framed-CBOR byte
stream, chunks pass through unparsed. Backpressure pauses either side while a
buffer is full. An apply watcher polls once a second: a bot with a pending
`.apply` and no active relay is stopped and reconciled; a busy bot applies on
its next attach. JSON bodies cap at 64 KiB; errors are `{error}` with HTTP
status.

## TUI

The experimental client TUI gets `/bot` (picker over `apiary list --json`) and
`/new` (fresh session, recorded before attach). Switching restarts the client
in-process against the target's socket; the turn itself continues on the
server. The launcher passes `PI_BOT_NAME` and `PI_BOT_BIN`; policy stays in
the launcher — the fork never reads state files.

## Web

The browser app lives in [`packages/web`](../web/README.md) and talks to the
same bridge.

## Tests

`node --test test/*.test.ts` (Node strips types; no test deps). Register and
lock tests use temp roots; bridge tests use a fake upstream and one live
prompt to a real bot.
