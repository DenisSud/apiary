# Architecture

The service map: what runs where, which state lives where, and the contracts
between the pieces. Ideas and interfaces only — each component's README is
the interface reference, the code is the how.

## Pieces

| piece | role |
|---|---|
| `base/` | pi package every bot loads: extensions `security`, `sysinfo`, `memory`, `mem0`; skills `self-config`, `skill-authoring` |
| `registry/` | optional per-agent packages: `ptc`, `web-search`, skills (`grilling`, `self-improvement`, `handoff`) |
| `packages/pi-manager` | bot lifecycle: scaffold, read, update, archive, delete; reconciler; admin settings |
| `packages/connector` | bot registry, launcher, bridge (HTTP API + WS relay), `pi-bot` CLI, web serving |
| `packages/auth` | provider login sessions over pi's `ModelRuntime` |
| `packages/auth/` | provider login sessions over pi's `ModelRuntime` |
| `packages/web` | browser client served by the bridge |
| `deploy/` | the container image and run scripts; the memory service stack (`deploy/mem0`) |
| pi fork (`$PI_SOURCE_DIR`) | the experimental server/client stack and service patches |

An agent is a complete pi agent dir under `$PI_BOTS_HOME`, its own git repo.
See `docs/agents.md` for what it is and what it owns.

## The lifecycle

1. **Create** — `pi-bot new <name>` (or the API) scaffolds the agent dir,
   commits `Scaffold <name>` and writes the `.setup` marker.
2. **Setup** — the web client sends `/skill:self-config`; the agent interviews
   the user and commits exactly `init`, which clears `.setup` and writes
   `.apply`.
3. **Attach** — a client resolves the bot: a pending apply runs (stop →
   reconcile → clear), the server starts from the pi checkout if needed, and
   the client attaches over a unix socket.
4. **Config commits** — a commit touching a config surface writes `.apply`; a
   bot with no attached client is stopped and reconciled before its next
   attach; an attached web client applies it once the turn settles.
5. **Archive / delete** — archive stops the server and writes a gitignored
   `.archived` marker; delete removes the dir after `{ confirm: name }`.

## State

| state | location | owner |
|---|---|---|
| agent dir | `$PI_BOTS_HOME/<name>` | the agent (config surfaces) |
| shared agent dir | `PI_SHARED_AGENT_DIR` (`~/.pi/agent`): `auth.json`, `models.json`, `models-store.json`, `trust.json` | the service; symlinked into every agent dir |
| connector state | `PI_CONNECTOR_DIR` (`~/.pi/bots`): routes, locks, logs, session pointers | the connector |
| admin settings | `<bot>/.admin-settings.json` | the reconciler (read by the server as `PI_ADMIN_SETTINGS`) |
| markers | `<bot>/.setup`, `<bot>/.apply` | the post-commit hook and the connector |
| sessions | `<bot>/experimental/sessions/` | the pi server |
| memory | mem0 service (external), notes in the agent dir | per the memory docs |

`.admin-settings.json`, `.setup` and `.apply` are gitignored; shared files are
symlinks, not copies.

## Contracts

| contract | writer → reader | shape |
|---|---|---|
| admin layer | pi-manager → fork settings-manager | `PI_ADMIN_SETTINGS` file merged after global + project settings |
| commit → apply | post-commit hook → bridge watcher / web client | `.apply` marker: stop → reconcile → attach |
| session pointer | clients → state root | `sessions/<bot>.json`, last attach wins, stale pointers self-heal |
| route | launcher → clients | `routes/<bot>.json`: `{ serverId, socketPath, pid }` |
| bridge data plane | browser ↔ bridge ↔ bot server | framed CBOR bytes, one WebSocket per session; the bridge never parses |
| server env | launcher → pi server | `PI_CODING_AGENT_DIR`, `PI_SERVER_DIR`, `PI_BOT_NAME`, `PI_ADMIN_SETTINGS`, `PI_REGISTRY_DIR` |

## Boundaries

- The container is the only supported runtime; devenv runs the service on the
  host for development only.
- Provider credentials and the model store live in the shared agent dir;
  agents never write them.
- Integration credentials are reached through secrets profiles; secret values
  never enter files, environment or model context (#13).
- Shared files are service-owned by convention today; the container makes it
  a real boundary.

## Where to read more

- Agents, identity, memory: `docs/agents.md`.
- Product and pillars: `docs/product.md`.
- Deployment: `docs/deployment.md`.
- Fork-specific behavior and bot-facing docs: the pi checkout (`$PI_SOURCE_DIR`).
