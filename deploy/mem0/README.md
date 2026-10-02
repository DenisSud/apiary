# mem0 deployment

The memory service (`docs/mem0.md`): one compose project on the RPi, under
rootless podman, fronted by Caddy (`memory.sudakov.site` → `127.0.0.1:8888`).
It is independent of the bots container — stopping bots must not stop memory.
Consumers hold only the URL and a consumer key.

| path | what |
|---|---|
| `compose.yml` | the stack: `mem0` + `db` (pgvector), named `mem0`/`mem0-db` |
| `app/` | the mem0 server (FastAPI), trimmed to the API server |
| `configure.sh` | replays the canonical `/configure` overrides after a deploy |
| `provision-keys.sh` | creates the admin account (first run) and consumer keys |

`app/` is mem0's `server/` at `mem0ai==2.2.1` (Apache-2.0,
github.com/mem0ai/mem0), minus the standalone dashboard. Keep the pin: the
`/configure` merge semantics and the auth model are version-sensitive.

## Fresh deploy

```sh
# on the RPi, from a copy of this directory (~/mem0)
podman-compose down
rm -rf pgdata history && mkdir -p pgdata history
# from the host — secrets are piped, never stored:
printf '%s\n%s\n' "$MEM0_ADMIN_API_KEY" "$MEM0_JWT_SECRET" | ssh denis@<rpi> \
  'read -r A && read -r B && cd ~/mem0 && export MEM0_ADMIN_API_KEY="$A" MEM0_JWT_SECRET="$B" && podman-compose up -d --build'
```

Then replay the configuration (overrides live in Postgres and die with it):

```sh
MEM0_URL=https://memory.sudakov.site OLLAMA_BASE_URL=http://<pc>:11434/v1 \
  MEM0_ADMIN_API_KEY=... ./configure.sh
```

Verify: no key → 401, admin key → `/configure` 200, and an add → search →
delete round trip. `pgvector` dims freeze at the first insert — fix the dims
before any memory is stored, not after.

## Consumer keys

```sh
MEM0_ADMIN_API_KEY=... ./provision-keys.sh   # first run also creates the admin account
```

Keys are shown once; store them in Bitwarden (folder `pi`): `mem0 pi` for the
personal agent, `mem0 fleet` for the bots container. The security profile
`mem0` maps them; the container gets `MEM0_API_KEY` injected at start. On this
server a consumer key is **not** namespace-scoped — it only lacks admin powers
and can be revoked per consumer.

## Consumers

| consumer | base URL | key | gate |
|---|---|---|---|
| personal agent (`~/.pi/agent`) | `https://memory.sudakov.site` | profile `mem0` → `MEM0_PI_KEY` | `http://<pc>:11434/v1`, `tev1:4b` |
| bots container | `https://memory.sudakov.site` | env `MEM0_API_KEY` (fleet key) | env `MEM0_GATE_BASE_URL` / `MEM0_GATE_MODEL` |

## Updating

`git pull` the checkout on the RPi, `rsync`/copy this directory over `~/mem0`
(keep `pgdata`/`history`), `podman-compose up -d --build`, rerun
`configure.sh` only if the config changed.

## Open items

- Nightly `pg_dump` + off-RPi copy.
- The server keeps a chat log (`history/`) and feeds recent messages into
  extraction context — a deleted memory can be re-extracted from it. Wipe
  `history/` alongside `pgdata/` for a truly clean slate.
