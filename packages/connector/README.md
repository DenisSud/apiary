# @pi-bots/connector — core (S1)

The shared decision layer: which bots exist, which session a bot should open,
and where that choice is recorded. No pi imports, no transports, no UI. The
launcher (S2), the TUI patch (S3) and the web app (S4) all use this package.

## Model

A bot is an agent dir at `$PI_BOTS_HOME/<name>` (default `~/Bots`). A dir is a
bot when it has `settings.json` — the same rule as `pi-bot list`.

State root: `$PI_CONNECTOR_DIR` (default `~/.pi/bots`), machine-local.

```
~/.pi/bots/
  state.json          per-bot session pointer (last attached wins)
  <name>/server.json  route written by the launcher:
                      { serverId, socketPath, pid, startedAt }
```

### state.json

```json
{ "bots": { "dev": { "serverId": "…", "sessionId": "…", "updatedAt": "…" } } }
```

Writes replace the file atomically (temp + rename). Concurrent writers are
last-write-wins — which is exactly the rule "the last attached session is the
default". Old sessions are never deleted; a pointer to a missing session only
means the client will create it again under the same id (`--session-id`
semantics), so the pointer stays valid.

### Route file

Written and removed by the launcher (`pi-bot serve`), read by every client.
The core only defines and validates its shape; process management is S2.

## API

```
listBots(): BotInfo[]                        // name, dir, hasRoute
readRoute(name): Route | undefined
writeRoute(name, route): void
clearRoute(name): void

readState(): State
resolveSession(name): SessionRef | undefined
recordAttached(name, ref): void
newSessionId(): string                       // crypto.randomUUID()
```

## Layout

```
src/paths.ts     state root, env overrides
src/registry.ts  bot scan + route files
src/pointer.ts   state.json read/write, session resolution
src/index.ts     re-exports
```

## Tests

`node --test test/*.test.ts` (Node strips types; no test deps). Each test
points `PI_CONNECTOR_DIR` and `PI_BOTS_HOME` at a temp dir.

## Open decisions

- `bots.yaml` (job text for the web UI) is not read here yet. Add a small
  parser or a dependency in S4, when the UI actually needs descriptions.
- One state file (last-write-wins across bots) versus one file per bot. A
  single file also gives "last focused bot" for free later.
