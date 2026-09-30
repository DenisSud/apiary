# AGENTS.md — working in pi-bots

Behavior rules for agents working in this repository. Knowledge lives in
`docs/`, the package READMEs and the issue tracker; this file says how to
behave here.

## Keep this file current

This file is only useful while it is true. Treat it as part of the change:

- A command, path, or convention changed → fix it here in the same commit.
- You had to discover how to run, test, or verify something → add it to the
  relevant section (or to `docs/` if it is knowledge, not behavior).
- A rule below turns out to be wrong or obsolete → delete it instead of
  working around it.
- A plan, design discussion, or rationale → `docs/`, never here.

If you are an agent that just spent effort figuring something out, that effort
is the signal to write it down.

## What this project is

A service that runs a fleet of pi agents and exposes them through a web app
(and later native desktop and mobile clients). One agent is one pi agent dir;
the shared backend is pi's experimental server stack behind a small connector;
the browser client is `packages/web`. The long-term deployment is
JupyterLab-style: one container per user holds the agents, their shared
environment, their memory, and the service itself. See `docs/vision.md`.

This repository is the **base of the system**, not one person's
configuration. Keep it usable by someone else. Personal deployment details
(a fleet, homelab, memory repos, private integrations) belong in the user's
agent dirs and the local rules overlay — not in the base.

## How to interact with the maintainer

- Answer first, then act. No filler, no praise, no restating the request.
- Be concise and technical. Say whether you agree or disagree before saying
  what you changed.
- Push back when you see a better approach; surface assumptions early.
- Execute autonomously when the path is clear. Ask before consequential or
  irreversible steps (deleting data, publishing, renaming, rewriting history,
  adding dependencies, expanding scope).
- Never commit unless asked. When asked, stage explicit paths — only files you
  changed in this session.
- Never print, copy, or paste secret values. Credentials are reached through
  the `security` extension's secrets profiles (`bash { secrets: "<profile>" }`,
  ptc `secrets_sh`); keep them out of code, docs, notes and commits.

## How to work

- Read before editing: the file and its callers; the package README when the
  change crosses module boundaries. Do not rely on search snippets for broad
  changes.
- Smallest solution that holds. Reuse what exists; no abstractions,
  dependencies, or configuration for hypothetical needs.
- Fix root causes, not symptoms: one fix where all callers route through.
- Keep behavior and knowledge apart: behavior here, plans and rationale in
  `docs/`, per-package detail in the package READMEs.
- ESM only, top-level imports, no `any` unless unavoidable. Node 24 runs the
  TypeScript directly (type stripping), so tests are plain `node --test`.
- Direct external dependencies are pinned to exact versions. Ask before
  adding one.
- Verbatim prompt text is load-bearing: tool `description` /
  `promptGuidelines` and a bot's `SOUL.md` are rendered into system prompts.
  Edit them deliberately.

## Layout

| path | what |
|---|---|
| `base/` | the base pi package every agent loads — extensions: security, sysinfo, memory; skills: skill-authoring, self-config |
| `registry/` | agent-usable pi packages an agent may declare (ptc, web-search, systemone, grilling, self-improvement, handoff) |
| `packages/pi-manager/` | bot lifecycle: scaffold, read, update, archive, delete; reconciler and admin settings |
| `packages/connector/` | bot registry, launcher, bridge — `pi-bot`, `pi-bots-web` (`bin/`) |
| `packages/auth/` | provider login sessions over pi's `ModelRuntime` |
| `packages/systemone/` | System One decision client + shared config (local Kev) |
| `packages/web/` | browser client served by the bridge (vanilla TS, esbuild) |
| `packages/connector/fish/` | the `pi --bot <name>` fish function |
| `deploy/` | service container image: Dockerfile, build and run scripts (issue #18) |
| `docs/` | project vision, architecture, memory, container, self-config |
| `.pi/skills/` | project skills (pi loads them from the repo root) |
| `devenv.nix` | dev shell and task commands |

## Docs

- `docs/vision.md` — what the product is, the deployment model, the phases.
- `docs/architecture.md` — the service map: pieces, state, lifecycle, admin layer, attach path.
- `docs/memory.md` — the memory system: prompt sections, notes, scopes, tools.
- `docs/self-config.md` — bot vs stock pi surface by surface, and the docs to fork.
- `docs/container.md` — the container deployment: image, volume, decisions, deferred work.
- `registry/README.md` — the package registry: policy, package list, install path.
- `packages/pi-manager/README.md` — bot lifecycle API, scaffold shape, commit→apply, reconciler, archive semantics.
- `packages/auth/README.md` — provider login sessions and the bridge frame mapping.
- `packages/systemone/README.md` — the decision layer: System One client, config, wire protocol.
- `packages/connector/README.md` — the connector: model, API, launcher, bridge contract.
- `packages/web/README.md` — the web client: modules, data flow, rendering rules.
- `packages/web/design/plan.html` — the design reference (open in a browser).
- `.pi/skills/frontend-design/SKILL.md` — the rules for UI work.
- `.pi/skills/chrome-devtools-cli/SKILL.md` — driving a real browser from the
  terminal (upstream Chrome DevTools skill; NixOS setup in its `references/local.md`).
- Forgejo `DenisSud/pi-bots` issues #1–#32 — the service backlog; labels
  `pkg:*` and `area:*`, milestones `Service v1` and `Later`.

## The pi source monorepo

`~/dev/pi` is a fork of `earendil-works/pi` (Forgejo `DenisSud/pi`) with our
patches on branch `dev`. The connector and the web client depend on its
experimental client/server stack, which is not published:

- `packages/web/build.mjs` resolves `@pi/fork/*` imports to
  `$PI_SOURCE_DIR/packages/coding-agent/src` (default `~/dev/pi`) and aliases
  the installed `@earendil-works/*` packages to their built `dist/`.
- The launcher spawns bot servers from the same checkout (`$PI_SOURCE_DIR`);
  the published package does not ship the experimental runtime.
- Fork patches: `src/experimental/` (client TUI, session worker, coding-agent
  harness, services/activation, `cli/experimental/commands/client.ts`) plus
  the core service patches — `core/system-prompt.ts` (custom/behavior/memory
  sections and the bot docs prose), `core/settings-manager.ts` (admin settings
  layer), `core/package-manager.ts` (admin package union),
  `experimental/services/agent-controller-provider.ts` (`/skill:name`
  expansion), `experimental/services/models-provider.ts` (model select clamp)
  — and the bot docs under `packages/coding-agent/docs/`. Change them in
  `~/dev/pi` on `dev`, following that repo's own `AGENTS.md`, and sync with
  `git fetch upstream && git rebase upstream/main dev`.

Never copy pi source into this repo. If an experimental API changes upstream,
fix the fork and the call sites here together.

## Dev environment (devenv)

`devenv shell` gives node 24 + bun, jq, shellcheck, watchexec and the
`web_fetch` extractors; `bun install` re-runs when `bun.lock` changes.

| command | what |
|---|---|
| `check` | package suites (pi-manager, auth, decision, connector, web) and every extension harness (the pre-commit gate) |
| `test-ext [name…]` | extension harnesses only |
| `test-connector` | `node --test` for `packages/connector` |
| `build` | bundle `packages/web/dist` |
| `web` / `web-watch` | serve the app + bridge; rebuild on change |
| `bot <name>` | this checkout's `pi-bot` |
| `lint` / `doctor` | shellcheck the entrypoints; check pi, checkout, bots root, SearXNG |

`devenv up` builds and serves; `devenv test` runs `check`. Two host
dependencies stay outside the devenv on purpose: the `pi` binary (extension
test runners resolve the installed store from `command -v pi`) and the pi
source checkout (`$PI_SOURCE_DIR`).

Run `check` before committing code. It does not cover tests that need network
or a live bot; for those follow the package READMEs.

## ptc: fast debugging and bulk work

`ptc` runs a Node ESM program in a child process with the tools as global
async functions (`read`, `grep`, `find`, `sh`, `secrets_sh`, `web_search`,
`web_fetch`). Only what the program prints enters the context, which makes it
the fastest way to work in this repo:

- **Exercise real code.** Node 24 strips types, so import the repo's modules
  directly and call them:

  ```js
  const { resolveAttach } = await import("/absolute/path/to/pi-bots/packages/connector/src/launcher.ts");
  ```

  (Inline `await import()` is fine inside a ptc program; it is banned in the
  repo's own source, where imports stay top-level.)
- **Bulk reads and filtering.** Fan out `read`/`grep`/`find` with
  `Promise.all` and print only the summary.
- **Run and parse.** `sh({ command: "cd packages/connector && node --test test/*.test.ts" })`,
  then parse stdout; start the bridge and `fetch("/api/bots")`; drive the UI
  through a Chromium CDP script from `sh`.
- **Data wrangling.** JSON manifests, snapshot dumps, issue lists.
- **Secrets.** `secrets_sh({ profile: "forgejo", command })` for API calls —
  never read or print the values.

ptc programs use top-level `await` and `import` (no `require`). Write
throwaway scripts to `/tmp`, or use `ptc { path }` to rerun a saved one; do
not leave scratch files in the repo.

## Verification

- Pi-manager: `cd packages/pi-manager && node --test test/*.test.ts`.
- Auth: `cd packages/auth && node --test test/*.test.ts`.
- Decision: `cd packages/systemone && node --test test/*.test.ts`.
- Connector: `cd packages/connector && node --test test/*.test.ts`.
- Web: `bun run test -w packages/web` (pure core, no DOM).
- Extensions: `base/extensions/<name>/test/run.sh harness` (no network); registry
  packages: `registry/<name>/test/run.sh harness`.
- UI changes: follow `.pi/skills/frontend-design/SKILL.md`; match the check
  to the change (pure-core tests for logic, the real app for layout or state).
- Bot sessions: go through the connector, not the stock in-process path.
- Container: `deploy/build.sh` then `deploy/run.sh`; smoke it with
  `docker exec pi-bots pi-bot new smoke && docker exec pi-bots pi-bot resolve smoke`
  and `curl 127.0.0.1:8787/api/bots`. See `docs/container.md`.

## Git

- Stage explicit paths; never `git add -A`, never force-push, never rewrite
  shared history.
- Message prefix by area: `web:`, `connector:`, `extensions:`, `docs:` —
  short and descriptive; push after committing.
- `main` is the live base; work on `dev`.

## Personal deployment

The base stays generic. Anything personal — a specific fleet, private
remotes, homelab or site integrations — belongs in the agent dirs, in a
personal extension, or in an agent's own SOUL.md. If a change only makes
sense for one deployment, it does not belong in the base.
