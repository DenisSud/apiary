# Container (issue #18, local mode)

The deployment shape is JupyterLab-style: one container per user holds the
agents, their shared environment, and the service. This page covers the local
mode — the same image on the user's own machine. The hosted control plane
(#24) is a later layer above it. The container is the only supported runtime:
the service is not deployed on the host. `devenv` still runs it there for
development and tests; that is tooling, not a runtime.

## Image

`deploy/Dockerfile` builds `pi-bots:local`:

- node 24 (Debian bookworm slim) with git, jq, ripgrep, pandoc, poppler
  (pdftotext) and trafilatura for `web_fetch`;
- bun 1.4.2 (pinned) for the service build;
- `/opt/pi-bots` — this checkout, dependencies installed, web bundle built;
- `/opt/pi` — the pi source checkout the bot servers run from
  (`PI_SOURCE_DIR`); both trees are root-owned, and the container runs
  read-only (see Run), so nothing in the image can be written;
- a system git identity, so scaffold and notes commits work without a user
  config.

The bot servers run pi from source, so the pi checkout must carry its
generated model catalogs (`packages/ai/src/providers/data`). They are
gitignored and fetched from models.dev: run `npm run hydrate-model-data` in
`$PI_SOURCE_DIR/packages/ai` once per checkout before building, otherwise the
servers die at startup. (If models.dev is unreachable, the same files ship in
the published `@earendil-works/pi-ai` tarball under `dist/providers/data/`,
but the version must match the checkout's `*.models.ts`.) `build.sh` refuses
to build without them.

Build from the local checkouts:

```sh
deploy/build.sh            # pi-bots:local
deploy/build.sh pi-bots:test
```

`build.sh` assembles a temp build context from this working tree and
`$PI_SOURCE_DIR` (default `~/dev/pi`), excluding `node_modules` and `.git`;
dependencies are installed inside the image.

## Run

```sh
deploy/run.sh              # docker run --rm -it --read-only --tmpfs /tmp --init \
                           #   --cap-drop ALL --security-opt no-new-privileges \
                           #   --memory 4g --cpus 4 --pids-limit 512 \
                           #   -p 127.0.0.1:8787:8787 -v pi-bots-data:/data
```

The container filesystem is read-only: only the volume and `/tmp` are
writable, so the image trees cannot change at run time. `--init` reaps the
detached bot servers; the dropped capabilities and `no-new-privileges` cost
nothing because the service needs none. Resource limits are conservative
defaults (`PI_BOTS_MEMORY`, `PI_BOTS_CPUS`, `PI_BOTS_PIDS` override them);
the hosted control plane (#24) will own per-user limits.

Semantic memory: `base/extensions/mem0/` reads `MEM0_BASE_URL` and
`MEM0_API_KEY` (a consumer key) plus `MEM0_GATE_BASE_URL` / `MEM0_GATE_MODEL`
for the capture gate. Export them when starting the container — the launcher
forwards its environment to every bot server. Keys are injected at run time,
never baked into the image (no rbw inside).

Everything stateful lives in the `/data` volume:

| path | what |
|---|---|
| `/data/bots` | the agent dirs (`PI_BOTS_HOME`) |
| `/data/state` | server routes, locks, logs (`PI_CONNECTOR_DIR`) |
| `/data/home/.pi/agent` | shared agent dir: `auth.json`, `models.json`, `models-store.json`, `trust.json` (`PI_SHARED_AGENT_DIR`) |

The port is published on loopback only. There is no auth in front of the
bridge yet; do not expose it to a network until #18's auth work lands.

Inside the container the service works as it does on the host:

```sh
docker exec -it pi-bots pi-bot new smoke     # scaffold an agent
docker exec -it pi-bots pi-bot resolve smoke # start its server, print the session
```

## Decisions

- **One volume per user.** Agents, state and credentials move together; the
  image is disposable and updates replace it.
- **Container-only runtime.** There is no host deployment path: the service,
  its bots and their servers all run in the per-user container. The devenv
  shell runs the service on the host for development only.
- **Spawn stays passthrough.** The launcher starts bot servers as local child
  processes inside the container; the `ServerSpawner` seam is kept for a
  later spawner (per-bot container, remote worker), but the service itself
  always runs in the per-user container.
- **Base package read-only.** `/opt/pi-bots` is root-owned and the container
  runs with `--read-only` and `--tmpfs /tmp`, so the image trees — including
  the registry at `/opt/pi-bots/registry` (`PI_REGISTRY_DIR`) — cannot be
  written even by root in the container. The reconciler writes admin settings
  into the bot dirs, not into the image.
- **Provider credentials are user state.** They live in the volume's shared
  agent dir, written by the web app's login flow, never baked into the image.

## Deferred

- Auth in front of the bridge (part of #18); the control plane built into
  the service, proper per-user limits, idle suspend (#24).
- CD: build and publish images on push, update without data loss (#32).
- Migrating existing agent dirs into a volume (#31).
- The local runner (#15) so agents can reach the user's device.
