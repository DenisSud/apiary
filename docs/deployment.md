# Deployment

The container is the product's runtime: one image, one volume per user. This
page covers the local, self-hosted shape; the hosted control plane is tracked
in #18 and self-host completeness in #36.

## Image

`deploy/Dockerfile` builds `apiary:local` from two trees:

- this repo at `/opt/apiary` (dependencies installed, web bundle built);
- the pi checkout at `/opt/pi` (`PI_SOURCE_DIR`) — bot servers run from it,
  so it must carry its generated model catalogs (`npm run hydrate-model-data`
  in `packages/ai` once per checkout; `build.sh` refuses to build without
  them). `build.sh` takes the `pi/` submodule by default.

node 24 + pinned bun; the image trees are root-owned (the container runs
read-only). A system git identity is baked in, so scaffold and notes commits
work headless.

```sh
deploy/build.sh              # apiary:local, from the local working trees
deploy/run.sh                # docker run ... /data volume, loopback port 8787
```

Run hardening: read-only root, tmpfs `/tmp`, dropped capabilities,
`no-new-privileges`, conservative memory/CPU/pid limits (`APIARY_*`
overrides). The port is published on loopback only: **no auth is in front of
the bridge yet** — do not expose it (#36).

## Volume

Everything stateful lives in `/data`:

| path | what |
|---|---|
| `/data/bots` | the agent dirs (`APIARY_HOME`) |
| `/data/state` | routes, locks, logs (`PI_CONNECTOR_DIR`) |
| `/data/home/.pi/agent` | shared agent dir: `auth.json`, `models.json`, `models-store.json`, `trust.json` |

The image is disposable; updates replace it, the volume moves.

## External services

- **mem0** — semantic memory, run as its own service in its own repo
  (`DenisSud/mem0`; the stack is `deploy/` there: compose, image, `/configure`
  replay, keys). Consumers take the base URL, a key and the `user_id` they
  write and read under; the service filters memories itself, on ingest and on
  output, so no consumer needs a decision model or its own copy of the server.
  Keys are injected at run time, never baked in.

## Decisions

- **One volume per user.** Agents, state and credentials move together.
- **Container-only runtime.** No host deployment path; devenv on the host is
  development tooling.
- **Spawn stays passthrough.** Bot servers are local child processes; the
  `ServerSpawner` seam exists for a later spawner, but the service always runs
  in the per-user container.
- **Base is read-only.** Registry and image trees cannot be written; the
  reconciler writes into the bot dirs.
- **Provider credentials are user state.** Written by the login flow, never
  baked into the image.

## Deferred

- Auth in front of the service, CD (build/publish from committed state,
  zero-loss updates), migrating existing host setups into a volume (#36).
- Hosted provisioning, per-user limits, idle suspend (#18).
- The local runner (#15, under #13).
