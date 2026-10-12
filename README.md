# apiary

A small service that runs a **fleet of personal AI agents** --- agent
lifecycle, a connector, a web client, and the deployment. Agents are owned,
not rented: each one is a complete, self-contained git repo with its own
persona, skills, extensions, settings, sessions, and memory, living under
`~/Bots`.

## Status

Seven agents in daily use: coding, time management, contacts (Gmail), the
homelab, relocation, memory curation, and a chief of staff that owns the
fleet. The `apiary` CLI runs them; the web client manages the fleet.

## Layout

```
├── package.json          # bun workspace root (service monorepo)
├── base/                 # the pi package floor every agent loads — empty for now
├── registry/             # packages an agent may install — empty for now
├── pi/                   # submodule: our pi fork (server runtime + service patches)
├── packages/connector/   # agent registry, launcher, bridge, the CLI wrappers (bin/)
├── packages/pi-manager/  # agent lifecycle: scaffold, read, update, archive, delete
├── packages/auth/        # provider login sessions over pi's ModelRuntime
├── packages/web/         # browser client served by the bridge
├── LICENSE               # Elastic License 2.0 (source-available)
├── docs/                 # product, architecture, agents, deployment
├── deploy/               # service container: Dockerfile, build and run scripts
├── devenv.nix            # dev shell: node + bun, extractors, one command per task
└── .pi/skills/           # project skills (frontend design, Chrome DevTools)
```

## Docs

| doc | what it covers |
|---|---|
| `AGENTS.md` | dev rules for this repo — read before changing anything |
| `docs/product.md` | what the product is: pillars, principles, phases |
| `docs/architecture.md` | the service map: pieces, state, contracts, boundaries |
| `docs/agents.md` | what an agent is: identity, memory, ownership, commit→apply |
| `docs/deployment.md` | the container: image, volume, external services |
| `packages/auth/README.md` | provider login sessions and the bridge frame mapping |
| `packages/connector/README.md` | the agent registry, launcher and bridge |
| `packages/web/README.md` | the browser client: modules, data flow, rendering rules |
| `packages/web/design/plan.html` | the web app's design reference (open it in a browser) |
| `.pi/skills/` | project skills (frontend design, Chrome DevTools) |
| `registry/README.md` | the package registry: empty for now, install path |

## Base

`base/` is a pi package: a manifest (`package.json`) with an `extensions/` and
a `skills/` directory. Every agent loads it — it is the enforced floor, not an
optional install. Both directories are empty for now, so the floor is the tool
floor at runtime and the content comes from the deployment's own package.

## Registry

`registry/` is the directory the service exports as `APIARY_REGISTRY_DIR`: where a
curated package an agent may install for itself would live. It holds no
packages for now. Adding one is declaring it in the bot's `settings.json`
`packages` list — a path under `$APIARY_REGISTRY_DIR`, any other path, or a git
URL — and the service installs the union on reload. See `registry/README.md`.

## Agents

```bash
apiary <name>        # run an agent
apiary list          # which agents exist
apiary new <name>    # scaffold one under $APIARY_HOME
```

An agent run is just `PI_CODING_AGENT_DIR=$APIARY_HOME/<name>` — no `-e`, no
`--append-system-prompt`, no `--session-dir`. Pi reads the agent dir as its
agent dir: `SOUL.md` is the prompt preamble and `BEHAVIOR.md` the behavior
section, `skills/` and `extensions/` load
like any agent dir, `settings.json` pulls in this package, sessions stay
local, and the memory extensions point at the agent's own notes. Shared
plumbing (`auth.json`, `models.json`, `models-store.json`, `trust.json`) is
symlinked from the shared agent dir, so credentials, model catalogs and trust
decisions are common to all agents.

Agents start **local-first**. When one must run on another machine, give it a
private remote — pull --rebase before editing, push after.

## Run

The container is the only supported runtime: `deploy/run.sh` runs the service
from the `apiary:local` image, with the `/data` volume holding agents, state
and credentials (see `docs/deployment.md`). The devenv shell runs the service on
the host for development only.

### Settings

A new agent's `settings.json` seeds from the shared agent dir's settings
(excluding `packages`) and gets the tool floor and the base package. The admin
layer supplies the enforced model and the mandatory packages at runtime; see
`docs/architecture.md`.

### Identity

Each agent's `SOUL.md` becomes the system prompt preamble and `BEHAVIOR.md`
the always-on behavior section; both are plain files the agent and the user
edit together. The `memory` extension contributes the notes policy as the
`<memory>` section, and the rest of the prompt is pi's structured tool, docs
and project sections.

### Commit is apply

A bot repo has a post-commit hook: during setup only the agent's `init`
commit applies, afterwards any commit touching `SOUL.md`, `BEHAVIOR.md`,
`settings.json`, `skills/` or `extensions/` applies. Apply means the bridge
stops the server when idle, reconciles the service invariants and starts a
fresh one on the next attach. Notes-only commits never restart anything.

## Add an agent

```bash
apiary new <name>             # scaffold $APIARY_HOME/<name> (name only)
apiary <name>                 # run it; the web client starts self-configuration
```

The web onboarding creates the agent and sends `/skill:self-config Set me
up.`; the skill interviews the user, edits SOUL.md / BEHAVIOR.md / settings /
skills, and commits `init`.

`apiary show/archive/unarchive/rm` manage the rest; the bridge exposes the same
operations over HTTP (`packages/pi-manager` owns the lifecycle).

## Development

`devenv shell` gives you node 24 + bun, jq, shellcheck, watchexec and the
`web_fetch` extractors — no system packages needed beyond `pi` itself.
`bun install` re-runs when `bun.lock` changes.

Tasks are devenv scripts, all listed by `devenv info`:

| command | what it does |
|---|---|
| `check` | package suites (pi-manager, auth, connector, web) and every extension harness (the pre-commit gate) |
| `test-ext [name…]` | extension harnesses only — all, or named ones |
| `test-connector` | `node --test` for packages/connector |
| `test-web-search-live` | live web-search test (needs the local SearXNG) |
| `build` | bundle packages/web/dist |
| `web` | serve the app + bridge on 127.0.0.1:8787 |
| `web-watch` | rebuild the bundle while packages/web/src changes |
| `bot <name>` | this checkout's apiary (local connector source) |
| `lint` | shellcheck the shell entrypoints |
| `doctor` | pi, the pi source checkout, agents root, SearXNG |

`devenv up` builds the web app and serves it; `devenv test` runs `check`.

The devenv deliberately avoids `languages.javascript`, which prepends
`node_modules/.bin` to PATH: bun's auto-installed peer `pi-coding-agent` would
shadow the installed `pi` binary there. Plain packages keep the installed pi
authoritative; `doctor` reports its version.

The pi source checkout is the `pi/` submodule. Agents are spawned from
`$PI_SOURCE_DIR` (default: the submodule) and the web bundle resolves
`@pi/fork/*` there. Its dependencies and generated model catalogs are a
one-time job per checkout:

```sh
(cd pi && npm ci)
(cd pi/packages/ai && npm run hydrate-model-data)
```

`doctor` reports whether both are in place.

Run `check` before opening a PR. `main` is protected: branch per feature (or
a short-lived fix branch) off `main`, push, and open the pull request on
GitHub.

## License

[Elastic License 2.0](LICENSE) (`Elastic-2.0`). Use, copy, modify and
distribute freely — including internal and commercial use — except offering
the software to third parties as a hosted or managed service. The `pi/`
submodule keeps the license of our pi fork (MIT).

Outside contributions must be accompanied by the copyright assignment in
[`docs/cla.md`](docs/cla.md), so the project's copyright stays in one hand
and relicensing stays clean.
