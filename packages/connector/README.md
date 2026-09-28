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

## Launcher (S2a)

`bin/pi-bot` becomes a thin shell script: resolve the repo root and
`exec node packages/connector/src/bin.ts "$@"`. All verbs live in TypeScript;
`list` is `listBots()`. `new` still delegates to `pi-bot-new`.

```
pi-bot attach <bot> [--new]   ensure server, resolve session, run the client
pi-bot resolve <bot> [--new]  ensure server, print the ref (for the S3 fork)
pi-bot list
pi-bot new <name>
pi-bot <bot> [--new]          sugar for attach
```

There is no `serve` verb. A bot runs only as a server; the stock in-process TUI
path for bots is gone.

### Server runtime per bot

```
PI_SERVER_DIR  ~/.pi/bots/servers/<bot>
serverId       route's id if present, else crypto.randomUUID() (canonical v4)
socket         getUnixSocketPath(serverId, dir) from @earendil-works/pi-server/unix
sessions       <bot>/experimental/sessions (the server default with PI_CODING_AGENT_DIR set)
log            ~/.pi/bots/logs/<bot>.log (append)
```

Spawn (detached, `cwd` = bot dir):

```
node --import <file://…/src/experimental/source-resolver.ts> \
     <checkout>/packages/coding-agent/src/experimental/cli.ts server \
     --server-id <uuid>
env: PI_EXPERIMENTAL=1 PI_CODING_AGENT_DIR=<bot> PI_MEMORY_DIR=<bot>/memory \
     PI_SERVER_DIR=<dir>
stdio -> log fd, detached, unref
```

This is exactly the argv the checkout's `pi-test.sh` builds, minus the shell:
we call `node` directly so the pid in the route **is** the server process and
`stop` can signal it. `pi-test.sh` keeps a shell parent, so its pid would be the
shell's, not the server's.

Readiness: connect with `@earendil-works/pi-client` and its `/unix` transport,
which checks the protocol handshake, then dispose. Retry until 10 s; on timeout
SIGKILL the child and print the log tail. No stdout parsing. The published
client version and the source commit must match (handshake rejects mismatches);
that is the pin.

### Route and lock

`routes/<bot>.json` is written before the spawn with the chosen `serverId`, so a
concurrent launcher sees a pending route, and updated with `pid` and `startedAt`
after readiness. The listener unlinks stale sockets, so reusing a server id after
a crash is safe.

`~/.pi/bots/locks/<bot>.lock` is an `open(..., "wx")` lock holding a pid. Stale
(dead pid or older than 30 s) locks are removed and retried. It is held only
across spawn and readiness.

### Attach flow

1. `readRoute`; if the client can connect to the socket, use it.
2. Else take the lock, re-read the route, then generate or reuse the server id,
   write the route, spawn, wait for readiness, release the lock.
3. `sessionId` = the pointer's, or `newSessionId()` when `--new`.
4. `recordAttached` (record-then-attach), then run the checkout's client with
   inherited stdio and exit with its status:

```
<checkout>/pi-test.sh client --connect unix://<socket> --session-id <id>
```

### Files

```
src/lock.ts      O_EXCL lock with stale takeover
src/launcher.ts  ensure server, readiness probe, attach resolution
src/bin.ts       verb dispatch
```
