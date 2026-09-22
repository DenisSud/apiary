# AGENTS.md

Operating notes for AI agents working in this repo. Denis edits with pi; this file keeps any agent on the same conventions.

## What this repo is

Denis's pi setup as one monorepo:

- **base** (repo root) — `extensions/`, `skills/`, `global/AGENTS.md`, shareable `settings.json`. Installed via `pi install <checkout>`; loaded by every agent.
- **bots** (`bots/<name>/`) — pi packages loaded with `-e` by the `pi-bot` wrapper (`pi --bot <name>`). They layer on top of the base.

Supersedes `DenisSud/pi-setup` (merged 2026-09-22; its git history was grafted onto this one).

## Hard rules

- **Keep secrets out.** No passwords/API keys in this repo (memory notes included) — credentials live in Bitwarden (folder `pi`) and reach a command only through the `security` extension's secrets profiles (`bash { secrets: "<profile>" }`, ptc `secrets_sh`); never print, copy, or paste secret values into notes, prompts, commits, or replies.
- Extensions import only from the aliased packages: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `typebox`. No new npm dependencies. Skills are markdown.
- Run extension tests before committing: `extensions/<name>/test/run.sh harness` (no network). Consult also has a `live` mode (needs `CONSULT_KEY`, costs ~$0.01).
- Commit with short descriptive messages; push after committing.

## Load-bearing copy

Tool `description`, `promptSnippet`, and `promptGuidelines` are rendered verbatim into the agent's system prompt. They are **instructions the model follows literally** — editing them changes agent behavior more than any code path. Phrasing is load-bearing:

- **consult** — neutral usage posture: when consult is useful, no frequency hype, no gatekeeping. Keep it matter-of-fact.
- **sysinfo** — read-only machine facts injected into the system prompt; keep it fast and side-effect-free.

## Bots

- Bots are additive: never duplicate base skills in a bot package.
- `bots/<name>/APPEND_SYSTEM.md` is rendered verbatim into the system prompt — edit deliberately.
- Add a bot by creating `bots/<name>/` with `package.json` (`"pi": {"skills": ["./skills"]}`), `skills/`, and `APPEND_SYSTEM.md`. The wrapper needs no change; `install.sh` discovers it.

## Repo layout

- `extensions/<name>/` — `index.ts` (factory exporting default), `test/harness.mjs`, `test/run.sh` (symlinks the aliased packages, runs harness / live).
- `skills/<name>/SKILL.md` — base skills. Format guide: `skills/writing-great-skills/SKILL.md`.
- `bots/<name>/` — a bot package: `package.json`, `APPEND_SYSTEM.md`, `skills/`.
- `bin/pi-bot`, `fish/pi.fish`, `install.sh` — the `pi --bot <name>` wrapper and installer.
- `package.json` — base pi package manifest (`pi.extensions`, `pi.skills`).

## Verify

- Wrapper: `fish -c 'pi --bot dev --version'`.
- Bot load: `pi-bot dev --no-session -p "List the skills available to you."` — asking the model is unreliable; for a mechanical check use `loadSkills()` from pi's `dist/core/skills.js`.
- Extension tests: `extensions/<name>/test/run.sh harness`.

## Related but separate

- `~/.pi/agent/memory/` — personal memory notes, a separate private git repo, synced across devices. When you change behavior agents rely on (e.g. extension contracts), update the relevant notes there and push both repos.
