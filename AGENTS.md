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
- A plan, design discussion, or rationale → the issue tracker or a component
  README, never here.

If you are an agent that just spent effort figuring something out, that effort
is the signal to write it down.

## What this project is

A service that runs a fleet of pi agents and exposes them through a web app
(and later native desktop and mobile clients). One agent is one pi agent dir;
the shared backend is pi's experimental server stack behind a small connector;
the browser client is `packages/web`. The long-term deployment is
JupyterLab-style: one container per user holds the agents, their shared
environment, their memory, and the service itself. See `docs/product.md`.

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
  the `security` extension's secrets profiles (`bash { secrets: "<profile>" }`);
  keep them out of code, docs, notes and commits.

## How to work

- Read before editing: the file and its callers; the package README when the
  change crosses module boundaries. Do not rely on search snippets for broad
  changes.
- Smallest solution that holds. Reuse what exists; no abstractions,
  dependencies, or configuration for hypothetical needs.
- Fix root causes, not symptoms: one fix where all callers route through.
- Keep behavior and knowledge apart: behavior here; docs hold durable ideas
  and component interfaces; specs of record live in the issue tracker;
  per-package detail in the package READMEs.
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
| `base/` | the pi package floor every agent loads — empty for now (no extensions, no skills) |
| `registry/` | `$PI_REGISTRY_DIR`: where an installable agent package would live — empty for now |
| `pi/` | submodule: our `earendil-works/pi` fork — the experimental server/client stack and the service patches |
| `packages/pi-manager/` | bot lifecycle: scaffold, read, update, archive, delete; reconciler and admin settings |
| `packages/connector/` | bot registry, launcher, bridge — `pi-bot`, `pi-bots-web` (`bin/`) |
| `packages/auth/` | provider login sessions over pi's `ModelRuntime` |
| `packages/web/` | browser client served by the bridge (vanilla TS, esbuild) |
| `deploy/` | service container image: Dockerfile, build and run scripts (issues #18, #36) |
| `docs/` | product spec, architecture, agents, deployment |
| `.pi/skills/` | project skills (pi loads them from the repo root) |
| `devenv.nix` | dev shell and task commands |

## Docs

- `docs/product.md` — what the product is: pillars, principles, phases.
- `docs/architecture.md` — the service map: pieces, state, contracts, boundaries.
- `docs/agents.md` — what an agent is: identity, memory, ownership, commit→apply.
- `docs/deployment.md` — the container: image, volume, external services.
- Docs state ideas and interfaces; the how lives in code, history in git, specs
  of record in the issue tracker. Never park design records here.
- `registry/README.md` — the package registry: empty for now, install path.
- `packages/pi-manager/README.md` — bot lifecycle API, scaffold shape, commit→apply, reconciler, archive semantics.
- `packages/auth/README.md` — provider login sessions and the bridge frame mapping.
- `packages/connector/README.md` — the connector: model, API, launcher, bridge contract.
- `packages/web/README.md` — the web client: modules, data flow, rendering rules.
- `packages/web/design/plan.html` — the design reference (open in a browser).
- `.pi/skills/frontend-design/SKILL.md` — the rules for UI work.
- `.pi/skills/chrome-devtools-cli/SKILL.md` — driving a real browser from the
  terminal (upstream Chrome DevTools skill; NixOS setup in its `references/local.md`).
- Forgejo `DenisSud/pi-bots` issues #1–#36 — the service backlog; labels
  `pkg:*`, `area:*` and `research`, milestones `Service v1` and `Later`.

## The pi source monorepo

The `pi/` submodule is our fork of `earendil-works/pi` (Forgejo `DenisSud/pi`).
The connector and the web client depend on its experimental client/server
stack, which is not published. The submodule pins one commit; the fork's own
`AGENTS.md` governs work inside it, and the branch it lives on is the fork's
business, not this file's:

- `packages/web/build.mjs` resolves `@pi/fork/*` imports to
  `$PI_SOURCE_DIR/packages/coding-agent/src` (default: the `pi/` submodule) and
  aliases the installed `@earendil-works/*` packages to their built `dist/`.
- The launcher spawns bot servers from the same checkout (`$PI_SOURCE_DIR`);
  the published package does not ship the experimental runtime.
- The pin must be a commit that carries the fork patches this repo calls into:
  `src/experimental/` (client TUI, session worker, coding-agent harness,
  `services/activation.ts`, `cli/experimental/commands/client.ts`) plus the
  core service patches — `core/system-prompt.ts` (custom/behavior/memory
  sections and the bot docs prose), `core/settings-manager.ts` (admin settings
  layer), `core/package-manager.ts` (admin package union),
  `experimental/services/agent-controller-provider.ts` (`/skill:name`
  expansion), `experimental/services/models-provider.ts` (model select clamp)
  — and the bot docs under `packages/coding-agent/docs/`.

To move the pin: check the commit out in `pi/`, run `check` and a bot smoke,
and commit the pointer here in the same PR as the call sites it needs. If an
experimental API changes upstream, fix the fork and the call sites here
together. Never copy pi source into this repo.

The checkout needs its own dependencies and generated model catalogs before
bots or the web bundle run from it — a fresh submodule has neither:

```sh
(cd pi && npm ci)
(cd pi/packages/ai && npm run hydrate-model-data)
```

`devenv`'s `doctor` reports both. Never copy pi source into this repo. If an
experimental API changes upstream, fix the fork and the call sites here
together.

## Dev environment (devenv)

`devenv shell` gives node 24 + bun, jq, shellcheck, watchexec and the
`web_fetch` extractors; `bun install` re-runs when `bun.lock` changes.

| command | what |
|---|---|
| `check` | package suites (pi-manager, auth, connector, web) — the pre-commit gate |
| `test-connector` | `node --test` for `packages/connector` |
| `build` | bundle `packages/web/dist` |
| `web` / `web-watch` | serve the app + bridge; rebuild on change |
| `bot <name>` | this checkout's `pi-bot` |
| `lint` / `doctor` | shellcheck the entrypoints; check pi, checkout, bots root, SearXNG |

`devenv up` builds and serves; `devenv test` runs `check`. The pi source
checkout is the `pi/` submodule; `$PI_SOURCE_DIR` overrides it (the container
bakes its own at `/opt/pi`).

Run `check` before opening a PR. It does not cover tests that need network
or a live bot; for those follow the package READMEs.

## codemode: fast debugging and bulk work

`codemode` runs a JavaScript program whose nested tool calls never enter the
context — only the program's output does, which makes it the fastest way to
work in this repo:

- **Bulk reads and filtering.** Fan out `tools.read` with `Promise.all`, or
  `tools.bash({ command: "grep -rn …" })`, and print only the summary.
- **Run and parse.** `tools.bash` returns `{ output, truncated, exit_code,
  wall_time_seconds }`; `await tools.bash({ command: "cd packages/connector && node --test test/*.test.ts" })`,
  then parse stdout; start the bridge and `tools.bash({ command: "curl 127.0.0.1:8787/api/bots" })`;
  drive the UI through a Chromium CDP script from `tools.bash`.
- **Data wrangling.** JSON manifests, snapshot dumps, issue lists.
- **Secrets.** `tools.bash({ command, secrets: "forgejo" })` for API calls —
  never read or print the values.

Scripts run in a sandbox (no Node, no filesystem, no network), so anything
that touches the real machine goes through `tools.bash`. Nested calls run
through the tool pipeline, so the security guard applies to each one.

## Verification

- Pi-manager: `cd packages/pi-manager && node --test test/*.test.ts`.
- Auth: `cd packages/auth && node --test test/*.test.ts`.
- Connector: `cd packages/connector && node --test test/*.test.ts`.
- Web: `bun run test -w packages/web` (pure core, no DOM).
- UI changes: follow `.pi/skills/frontend-design/SKILL.md`; match the check
  to the change (pure-core tests for logic, the real app for layout or state).
- Bot sessions: go through the connector, not the stock in-process path.
- Container: `deploy/build.sh` then `deploy/run.sh`; smoke it with
  `docker exec pi-bots pi-bot new smoke && docker exec pi-bots pi-bot resolve smoke`
  and `curl 127.0.0.1:8787/api/bots`. See `docs/deployment.md`.

## Git and Forgejo

Trunk-based: `main` is the only long-lived branch and is protected — changes
reach it only through a pull request on Forgejo, never a direct push.

- Sizable work: a branch per feature (`feat/<slug>` or `<area>/<slug>`),
  branched from `main`, pushed, PR'd into `main`, linked to its work thread
  (`Refs #N`).
- Small fixes: a short-lived `fix/<slug>` branch and a PR; no issue needed
  for trivia.
- Testing gate: `check` (plus the relevant smoke) before opening the PR.
- Merging is the maintainer's call; open the PR and stop.
- Stage explicit paths; never `git add -A`, never force-push, never rewrite
  shared history.
- Message prefix by area: `web:`, `connector:`, `extensions:`, `docs:` —
  short and descriptive.

## Personal deployment

The base stays generic. Anything personal — a specific fleet, private
remotes, homelab or site integrations — belongs in the agent dirs, in a
personal extension, or in an agent's own SOUL.md. If a change only makes
sense for one deployment, it does not belong in the base.
