# pi-bots

The pi-bots service: the base pi package every agent loads, the registry of
optional packages an agent can pick up, and the service that runs them —
connector, agent lifecycle, web client, deployment.

Agents do **not** live here. An agent is a complete pi agent dir (its own
persona, skills, extensions, settings, sessions, memory) in its own local git
repo under `$PI_BOTS_HOME` (default `~/Bots`). This repo is the one thing they
all load.

## Layout

```
├── package.json          # bun workspace root (service monorepo)
├── base/                 # the base pi package every agent loads (extensions, skills)
├── registry/             # agent-usable packages: ptc, web-search, systemone, grilling, …
├── packages/connector/   # agent registry, launcher, bridge, the CLI wrappers (bin/)
├── packages/pi-manager/  # agent lifecycle: scaffold, read, update, archive, delete
├── packages/auth/        # provider login sessions over pi's ModelRuntime
├── packages/systemone/  # System One decision client + shared config (local Kev)
├── packages/web/         # browser client served by the bridge
├── docs/                 # vision, architecture, memory, container, self-config
├── deploy/               # service container: Dockerfile, build and run scripts
├── devenv.nix            # dev shell: node + bun, extractors, one command per task
└── .pi/skills/           # project skills (frontend design, Chrome DevTools)
```

## Docs

| doc | what it covers |
|---|---|
| `AGENTS.md` | dev rules for this repo — read before changing anything |
| `docs/vision.md` | what the product is, the deployment model, the phases |
| `docs/architecture.md` | the service map: pieces, state, lifecycle, admin layer, attach path |
| `docs/self-config.md` | bot vs stock pi, surface by surface, and the docs to fork |
| `docs/memory.md` | the memory system: prompt sections, notes, scopes, tools |
| `docs/container.md` | the container image, volumes and run scripts |
| `packages/systemone/README.md` | the decision layer: client, config, wire protocol |
| `packages/connector/README.md` | the agent registry, launcher and bridge |
| `packages/web/README.md` | the browser client: modules, data flow, rendering rules |
| `packages/web/design/plan.html` | the web app's design reference (open it in a browser) |
| `.pi/skills/` | project skills (frontend design, Chrome DevTools) |
| `base/extensions/*/SPEC.md` | per-extension specs (`memory`) and registry package specs |
| `registry/README.md` | the package registry: policy and package list |

## Base

The base package lives in `base/`: a pi package manifest with `extensions/`
and `skills/`. Every agent loads it — it is the enforced floor, not an
optional install.

| extension | what it does |
|---|---|
| `security` | vault-backed secrets profiles, output redaction, credential-store guards |
| `sysinfo` | machine facts as the `<system_info>` prompt section |
| `memory` | SOUL.md as the prompt preamble, BEHAVIOR.md as the behavior section, shared and per-agent notes, auto-committed writes |

Skills: `skill-authoring` (how to write skills well) and `self-config` (the
setup interview and self-configuration workflow). The base is what every agent
gets; nothing else lives in it.

## Registry

`registry/` holds packages an agent may install for itself: `ptc`,
`web-search`, `systemone` (extensions) and `grilling`, `self-improvement`,
`handoff` (skills). Each directory is a pi package; an agent declares it in
its `settings.json` `packages` list and the service installs the union on
reload. The self-config skill points agents here; see `registry/README.md`.

`web-search` expects a SearXNG instance (`SEARXNG_BASE_URL`, default
`http://127.0.0.1:8888`) and the `trafilatura` + `pdftotext`/`pandoc` binaries
for `web_fetch`. The devenv shell ships the extractors.

`systemone` stays inert until `~/.pi/agent/systemone.json` exists; then it
classifies guarded tool calls (`bash`, `ptc`) through a local System One
endpoint, asking whether the call is dangerous and whether the user asked for
it — Kev serves one:
`uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009`.
It is a policy layer above the deterministic security guard, fail-open by
default. See `registry/systemone/SPEC.md`.

## Agents

```bash
pi-bot <name>        # run an agent
pi-bot list          # which agents exist
pi-bot new <name>    # scaffold one under $PI_BOTS_HOME
```

An agent run is just `PI_CODING_AGENT_DIR=$PI_BOTS_HOME/<name>` — no `-e`, no
`--append-system-prompt`, no `--session-dir`. Pi reads the agent dir as its
agent dir: `APPEND_SYSTEM.md` is the persona, `skills/` and `extensions/` load
like any agent dir, `settings.json` pulls in this package, sessions stay
local, and the memory extension points at the agent's own notes. Shared
plumbing (`auth.json`, `models.json`, `models-store.json`, `trust.json`) is
symlinked from the shared agent dir, so credentials, model catalogs and trust
decisions are common to all agents.

Agents start **local-first**. When one must run on another machine, give it a
private remote — pull --rebase before editing, push after.

## Run

The container is the only supported runtime: `deploy/run.sh` runs the service
from the `pi-bots:local` image, with the `/data` volume holding agents, state
and credentials (see `docs/container.md`). The devenv shell runs the service on
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
pi-bot new <name>             # scaffold $PI_BOTS_HOME/<name> (name only)
pi-bot <name>                 # run it; the web client starts self-configuration
```

The web onboarding creates the agent and sends `/skill:self-config Set me
up.`; the skill interviews the user, edits SOUL.md / BEHAVIOR.md / settings /
skills, and commits `init`.

`pi-bot show/archive/unarchive/rm` manage the rest; the bridge exposes the same
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
| `bot <name>` | this checkout's pi-bot (local connector source) |
| `lint` | shellcheck the shell entrypoints |
| `doctor` | pi, the pi source checkout, agents root, SearXNG |

`devenv up` builds the web app and serves it; `devenv test` runs `check`.

Two host dependencies stay outside the devenv on purpose:

- **`pi`** — the extension test runners resolve the installed pi store from
  `command -v pi`, so tests run against the same pi the agents run. The devenv
  deliberately avoids `languages.javascript`, which prepends
  `node_modules/.bin` to PATH — bun's auto-installed peer `pi-coding-agent`
  would shadow the system binary there and the runners could not resolve a
  monorepo store. `doctor` reports the version in use.
- **the pi source checkout** — agents are spawned from `$PI_SOURCE_DIR`
  (default `~/dev/pi`) and the web bundle resolves `@pi/fork/*` there.

Run `check` before committing; commit and push normally.
