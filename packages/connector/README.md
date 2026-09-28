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
  servers/             PI_SERVER_DIR shared by all bot servers (M0)
  routes/<bot>.json    { serverId, socketPath, pid, startedAt }  (launcher, S2)
  sessions/<bot>.json  { serverId, sessionId, updatedAt }        (clients, S1)
```

One file per bot per concern: each register is sharded by key, so updates to
different bots touch disjoint files and cannot overwrite each other. Writes
replace a file atomically (temp + rename); a reader sees the old or the new
file, never a torn one. Same-bot races are last-write-wins, which is exactly
the rule "the last attached session is the default".

`updatedAt` is informational. Ordering comes from the filesystem serializing
`rename()`, never from comparing wall clocks.

## API

```
listBots(): BotInfo[]                        // name, dir, hasRoute
readRoute(name): Route | undefined
writeRoute(name, route): void
clearRoute(name): void

readSession(name): SessionRef | undefined
recordAttached(name, ref): void
newSessionId(): string                       // crypto.randomUUID()
```

## Guarantees

- `recordAttached` is idempotent; once it returns, the calling process reads
  that value back. Nothing is promised about other processes.
- `resolveSession`-style reads never throw: missing, malformed or botless
  state reads as "no pointer". A pointer to a session that no longer exists is
  not an error — attaching with that id creates the session (`--session-id`
  semantics), so stale pointers self-heal.
- New session, in order: generate id -> record -> attach. If the process dies
  between record and attach, the next attach materializes exactly that
  session; the retry cannot create a second one.
- The pointer's `serverId` is informational. Attach uses the route's socket
  plus the pointer's `sessionId`; a server restart does not invalidate a
  session pointer, because sessions live in the bot's agent dir, not in the
  server. Verify this in S2.
- Clients never cache the pointer; it is read at attach time. A rendered view
  may lag, but the filesystem is the only copy, so nothing needs reconciling.

## Distributed system model

| Property | Value |
| --- | --- |
| Nodes | Client processes (TUI, web bridge) and one server process per bot, on one host today (pc or g14); multiple hosts at M5 |
| Network | Chord/RPC over unix sockets for the data plane; the state root is a shared filesystem for control |
| Temporal model | Asynchronous; no clock bounds. Wall clock is display-only |
| Faults | Crash-stop; no partitions today. M5 adds partitions between hosts, never between co-located processes |
| Topology | Single owner per bot: one server owns the session store; clients attach. No replication |
| Consistency | Control plane: linearizable per key via `rename()`. Data plane: upstream's single-writer harness with presentation attachments |

## Not doing (and why)

- **Vector clocks.** They exist to detect concurrent updates so a merge can
  respect causality. Our same-key conflict — two clients attaching different
  sessions to one bot — has no meaningful merge: one attach is the default, by
  definition. Causal metadata would add state with no decision to make.
- **FIFO-total-order broadcast / state machine replication.** There is no
  replica set. The state root lives on one host and `rename()` already totally
  orders writes to a file; cross-key updates are independent and commute. No
  client serves reads from replicated state, so there is nothing to replicate.
- **Anti-entropy / eventual consistency for client state.** Clients hold no
  authoritative state; every attach reads the pointer fresh.
- **Merging parallel writers in the event log.** One harness writes a
  session's event tree; extra attachments are presentations. Undo and fork are
  sequential tree operations upstream. If multi-agent parallel writes become a
  product need, that is an upstream Chord/services question, not ours.

Deferred to M5 (multi-host): reconnect and retry, prompt deduplication, auth.
Solve those with upstream mechanisms first.

## Layout

```
src/paths.ts     state root, env overrides
src/files.ts     atomic JSON read/write primitives
src/registry.ts  bot scan + route files
src/sessions.ts  per-bot session register
src/index.ts     re-exports
```

## Tests

`node --test test/*.test.ts` (Node strips types; no test deps). Each test
points `PI_CONNECTOR_DIR` and `PI_BOTS_HOME` at a temp dir.

## Open decisions

- `bots.yaml` (job text for the web UI) is not read here yet. A small parser
  or a dependency in S4, when the UI actually needs descriptions.
- "Last focused bot" is a global register, not a per-bot one; it gets its own
  file when a client needs it.
