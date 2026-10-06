# mem0 deployment

The memory service (`base/extensions/mem0/README.md`; ownership tracked in
#34): one compose project on the RPi, under
rootless podman, fronted by Caddy (`memory.sudakov.site` → `127.0.0.1:8888`).
It is independent of the bots container — stopping bots must not stop memory.
Consumers hold only the URL and a consumer key.

| path | what |
|---|---|
| `compose.yml` | the stack: `mem0` + `db` (pgvector), named `mem0`/`mem0-db` |
| `app/` | the mem0 server (FastAPI), trimmed to the API server |
| `fetch-fork.sh` | downloads the mem0 fork into `mem0-src/` — the library the image installs |
| `configure.sh` | replays the canonical `/configure` overrides after a deploy |
| `provision-keys.sh` | creates the admin account (first run) and consumer keys |

`app/` is mem0's `server/` at `mem0ai==2.2.1` (Apache-2.0,
github.com/mem0ai/mem0), minus the standalone dashboard. The **library** is not
PyPI's: it comes from our fork (`DenisSud/mem0`, ref pinned in
`fetch-fork.sh`), which adds the System One gates (#34). Keep both pins — the
`/configure` merge semantics and the auth model are version-sensitive.

## The gates

The service filters memories itself, through a System One model, in two places
(one extra HTTP call each):

- **ingest** — after extraction, before storing: a fact survives only if the
  model answers that it is durable information; chatter, requests, one-off
  details and secrets are dropped;
- **output** — after the vector search: a memory is returned only if the model
  answers that it bears on the query.

Both gates fail open (an error or a timeout keeps everything), ask one `noul`
question per item in a single call, and share the threshold from `/configure`
(`MEM0_GATE_THRESHOLD`, default 0.5). The code is the fork's
`mem0/systemone/`; the load-bearing part is the instruction wording in
`gates.py`, which is tuned for small local System One models — a vague question
scores everything high and filters nothing.

Measured on the PC's Ollama (`/v1/systemone`), over 5 candidate memories and 8
candidate facts, as the probability gap between the items that should pass and
the items that should not:

| model | output gate | ingest gate | per call |
|---|---|---|---|
| `nimble:latest` | +0.95 | +0.85 | ~0.6 s |
| `clef-flash:9b-8k` | +0.81 | +0.40 | ~0.3 s |
| `tev1:4b` | +0.55 | −0.14 | ~3 s |

`nimble:latest` is the default for that reason; `clef-flash:9b-8k` is the tagged
alternative (leaner ingest — raise the threshold or accept fewer stored facts).
A hosted jev is the upgrade path: the config is a base URL, a model and an
optional key, nothing else.

## Fresh deploy

```sh
# on the RPi, from a copy of this directory (~/mem0)
podman-compose down
rm -rf pgdata history && mkdir -p pgdata history
# from the host — secrets are piped, never stored:
printf '%s\n' "$FORGEJO_TOKEN" | ssh denis@<rpi> \
  'cd ~/mem0 && ./fetch-fork.sh'
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

Consumers hold only the base URL and a key: the filtering happens at the
service, so no client needs a decision model of its own.

| consumer | base URL | key |
|---|---|---|
| personal agent (`~/.pi/agent`) | `https://memory.sudakov.site` | profile `mem0` → `MEM0_PI_KEY` |
| bots container | `https://memory.sudakov.site` | env `MEM0_API_KEY` (fleet key) |

The clients still carry a capture gate and a recall filter of their own
(`base/extensions/mem0/`, the personal agent's `pi-memory-mem0` settings). Those
are redundant from here on and come out in the extension rework that follows.

## Updating

`git pull` the checkout on the RPi, `rsync`/copy this directory over `~/mem0`
(keep `pgdata`/`history`), rerun `fetch-fork.sh` when the pinned fork ref moved,
then `podman-compose up -d --build`; rerun `configure.sh` only if the config
changed.

## Open items

- Nightly `pg_dump` + off-RPi copy.
- The server keeps a chat log (`history/`) and feeds recent messages into
  extraction context — a deleted memory can be re-extracted from it. Wipe
  `history/` alongside `pgdata/` for a truly clean slate.
