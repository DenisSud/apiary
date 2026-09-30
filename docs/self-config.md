# Bot self-configuration vs. standard pi

Inventory of every self-configuration surface where a pi-bots agent ("bot")
differs from a stock pi agent, and the pi docs that describe each surface.
Purpose: patch the model-facing documentation intentionally, so agents do not
fight service-managed configuration or follow instructions that do not apply
to them.

Premise of the difference: stock pi assumes a technical user in charge, so
everything is user-writable and the docs say "ask Pi to change it". A bot
assumes a non-technical user and a service in charge: the agent is the only
one editing its files, and the service owns a small immutable layer.

## 1. The surface inventory

### Agent directory

Stock pi: `<agent-dir>` defaults to `~/.pi/agent`, set with
`PI_CODING_AGENT_DIR`. Bots: the agent dir **is** the bot directory
(`~/Bots/<name>`), cwd is the same directory.

| Path | Stock pi | Bot |
|---|---|---|
| `settings.json` | user settings, free | free **except admin-shadowed keys** (model locked, `packages` union, `defaultTools` floor); commit is apply (hook → `.apply` marker → service restart) |
| `keybindings.json` | TUI keybindings | irrelevant (no terminal UI) |
| `models.json` | custom endpoints/models | symlink to the shared agent dir; service-owned, read-only by convention |
| `models-store.json` | catalog cache | symlink to shared; service-owned |
| `auth.json` | credentials via `/login` | symlink to shared; service-owned (bridge auth proxy); read-only for the agent |
| `trust.json` | saved project trust decisions | symlink to shared; service-owned |
| `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` | user instructions | not scaffolded; free if the agent creates one |
| `SOUL.md` | — (new surface) | the identity source; the memory extension renders it as the system prompt preamble |
| `BEHAVIOR.md` | — (new surface) | always-on working rules; rendered as the `<behavior>` section; both the agent and the user edit it |
| `SYSTEM.md` | replaces the system prompt | unsupported surface; SOUL.md + BEHAVIOR.md cover identity and behavior |
| `APPEND_SYSTEM.md` | appends instructions | unsupported (dropped from the scaffold on purpose) |
| `extensions/` | user extensions | the agent's own package: free to write |
| `skills/` | user skills | free; registry recommended for shared ones |
| `prompts/` | prompt templates | not useful headless (no editor command surface); leave empty |
| `themes/` | terminal themes | irrelevant |

### Project `.pi` directory

Stock pi: `.pi/` under the cwd loads after project trust. Bots: the scaffold
has no `.pi/`; the server runs headless, so with `defaultProjectTrust: "ask"`
project resources are skipped (no interactive prompt). If a bot creates
`.pi/`, its own resources will not load unless the service adds a trust entry
(shared `trust.json`). The bot docs should say: put resources under the
agent-dir conventions, not `.pi/`.

If project settings ever do load, the admin layer merges after them too.

### Settings model

Stock pi: global settings merged with project settings (project wins; resource
arrays combine); `/settings` in interactive mode; `/reload` after manual
edits. Bots: same merge, plus the admin layer on top (fork patch). No
`/settings`, no `/reload`: **commit is apply** — a config-surface commit
triggers a service-side restart, not an in-session reload.

| Key area | Bot rule |
|---|---|
| model (`defaultModel`, `defaultProvider`) | admin, wins over anything; not exposed in the UI |
| `packages` | union: admin (base + mandatory) always present; agent may add |
| `defaultTools` | union floor: `read`, `write`, `edit`, `bash` always active; extension tools are always active regardless |
| `extensions`, `skills`, `prompts`, `themes` paths | combined as upstream; agent free |
| thinking (`defaultThinkingLevel`, `modelThinkingLevels`) | agent free |
| everything else (compaction, retry, display, …) | agent free; display/TUI keys irrelevant |

### Packages

Stock pi: `pi install npm:…|git:…|./path`, `pi remove`, `pi update`,
`pi config`, `--extension`; personal scope writes `~/.pi/agent/settings.json`,
project scope `.pi/settings.json`; deps installed under
`<agent-dir>/npm/node_modules` (or `.pi/npm/…`).

Bots: the base package and the mandatory packages are admin-managed; the
registry is the curated source the agent may install from. Declaring a package
in `settings.json` is enough — the reconciler installs the union on reload.
`pi install` via bash also lands in the bot dir (agent dir), so it works, but
the blessed path is declaration + reload. `pi update` and `pi remove` of
managed entries are service business; docs should not route the agent there.

### Extensions

Stock pi docs describe the complete extension API, including terminal UI,
context commands, providers, and `ctx.reload()`. Bots run the experimental
harness, which today supports only a subset: `setActiveTools`, `refreshTools`,
`getAllTools`, `setModel`, `getThinkingLevel` and the mapped events
(`before_run`, `transform_context`, `before_tool`, `after_tool`,
`before_payload`; the extension API name is `before_agent_start`, `context`,
`tool_call`, `tool_result`, `before_provider_request`, plus `session_start`).
Unsupported and logging: `sendMessage`,
`sendUserMessage`, `appendEntry`, `compact`, `setThinkingLevel`. There is no
in-session reload (`/reload` is interactive-only) and no terminal UI.

Consequence: bot docs must describe the supported subset and the
restart-based apply model, or agents will write extensions that silently do
nothing.

### Skills

Stock pi: skill directories with `SKILL.md`; advertised by name/description;
loaded on demand; `/skill:name` forces loading (interactive); `/reload` after
edits; package distribution. Bots: same skill model; `/skill:name` text routing has a fork patch
(the experimental `prompt()` routes it to the skill loader), so the web can
auto-load the setup skill; edits apply on commit; registry is the sharing
mechanism.

### Models and authentication

Stock pi: `/login`, `/logout`, `/model`, `/thinking`, `auth.json`,
provider env keys, `models.json`, custom provider extensions, `/llama`,
scoped models. Bots: authentication is machine-wide and service-managed (the
bridge auth proxy); the model is admin-locked (one model for now, thinking
free); `models.json` is shared; custom providers are not a bot concern. The
bot docs should say plainly: "your model and credentials are managed by the
service; do not try to change them; the `pi.models` select path is clamped."

### Security and trust

Stock pi: trust prompts per project; extensions and tools run with the OS
permissions of the user; containerization is the recommended boundary. Bots:
trust is service-managed (no prompts); the deployment boundary is the
per-user container (#18); locally the base dir is only advisory-read-only
until the container exists. The admin layer plus the reconciler are the
semantic boundary in the meantime.

### Updates, telemetry, installation

Stock pi: `pi update`, self-update commands, changelog, telemetry, uninstall.
Bots: the service owns the installation; an agent must not run `pi update`
(it would touch the host installation) or change telemetry settings that the
service relies on.

### Sessions and compaction

Stock pi: persistent JSONL sessions, branching, export/share commands,
compaction settings. Bots: sessions live in the bot dir; the web client has no
export/share UI; compaction behaves the same. Low-risk, minimal doc impact.

### Environment variables

Stock pi: `PI_*` for process config, process markers, and shell-tool session
state. Bots: `PI_CODING_AGENT_DIR`, `PI_SERVER_DIR`, `PI_BOT_NAME`,
`PI_EXPERIMENTAL` are set by the launcher; the agent must not override process
configuration. The shell-tool variables (`PI_MODEL`, `PI_SESSION_ID`, …)
remain useful and reflect the enforced model.

### Ours, with no upstream docs

SOUL.md identity, BEHAVIOR.md, memory policy + notes, registry, commit→apply
lifecycle, rollback through git, admin layer semantics. These need bot-side
docs written from scratch.

## 2. Doc-by-doc map

Status: the bot-facing docs were written in the fork during this pass; this
table is the record of what changed. Paths are relative to
`packages/coding-agent/docs/`.

| Doc | Self-config content | Bot action |
|---|---|---|
| `configuration.md` | agent dir + `.pi` tables; "ask Pi to update"; `/reload` | fork: bot file table (SOUL/BEHAVIOR/memory, service-owned symlinks), no `.pi`, commit→apply |
| `settings.md` | full settings reference; "run `/settings`" | fork: admin-shadowed key list, reload semantics, remove interactive bits |
| `packages.md` | install/remove/update, sources, manifests, `pi config` | fork: registry, declaration+reload, mandatory union, no `pi update` |
| `extensions.md` | full API, lifecycle, `ctx.reload()`, terminal UI | fork: supported subset, own package dir, restart apply |
| `skills.md` | create/share, `/skill:name`, `/reload` | light fork: registry, commit apply, skill commands work |
| `models.md` | `/login`, `/model`, `models.json`, custom endpoints | replace with short "service-managed" page (or drop from topic list) |
| `providers.md` | `/login`, env API keys, cloud auth | replace/drop; auth is service-level |
| `custom-provider.md` | provider extensions | drop from bot docs |
| `llama-cpp.md` | local models | drop |
| `security.md` | trust, OS permissions, isolation | keep, add a bot note (service trust, container boundary) |
| `containerization.md` | isolation methods for pi itself | keep out of bot topic list (service guidance; it is also the reference for our #18 work) |
| `environment-variables.md` | `PI_*` process config, shell vars | fork: launcher-set vars, don't override, shell vars stay |
| `themes.md`, `keybindings.md`, `tui.md`, `terminal-setup.md`, `windows.md`, `termux.md`, `tmux.md`, `shell-aliases.md` | TUI/platform | drop from bot docs |
| `sessions.md`, `session-format.md`, `compaction.md` | session mechanics | keep as-is |
| `cli.md`, `rpc.md`, `rpc-commands.md`, `rpc-extension-ui.md`, `json.md`, `sdk.md` | other interfaces | drop from bot docs |
| `usage.md`, `quickstart.md`, `index.md`, `how-pi-works.md` | general | keep general parts; index/quickstart entries about install/customize are service-level |
| `slash-commands.md` | command reference (incl. `/reload`, `/login`) | drop or fork to the web client's command surface |
| `message-types.md`, `session-export`/`share` topics | format details | keep as-is |

Conflicts that must not survive in the bot docs, verbatim examples:

- "ask Pi to update the configuration or edit the relevant files directly.
  Run `/reload` after manually changing settings…" — a bot cannot, and must
  commit instead.
- "Install from npm, git, or a local path: `pi install …`" — bot guidance is
  the registry + declaration; `pi update`/`pi remove` are service business.
- "`pi config` to enable or disable discovered resources" — interactive tool,
  not part of the bot surface.
- "`ctx.reload()`" / "Run `/reload`" in extensions/skills docs — bots apply by
  commit.
- "Run `/login` … `/model`" in models/providers docs — service-managed.
- "Extensions … same operating-system permissions" in security.md — true, but
  the bot should not assume it can change the isolation.

## 3. Bot docs set (landed)

Written in the fork's docs directory; upstream pages are edited in place, the
new pages sit next to them:

1. `self-config.md` — the authoritative page:
   - what the agent owns: SOUL.md, BEHAVIOR.md, `settings.json` (non-admin
     keys), skills, extensions, packages additions, thinking;
   - what the service owns: model, mandatory packages, tool floor, auth,
     shared files, updates;
   - commit→apply, the `init` commit, rollback through git;
   - registry usage;
   - the supported extension API subset.
2. `memory.md` — notes scopes, shared USER.md, auto-commit, policy rules.
3. `registry.md` — how to look up and add registry packages.

Plus the forked/overlaid upstream files from the table (initial set:
`configuration.md`, `settings.md`, `packages.md`, `extensions.md`,
`skills.md`, `environment-variables.md`; replacements for the model/auth
pages).

Fork requirements (decided: native edits in the fork):

The doc changes are made natively in the pi fork (`~/dev/pi`), the same way
the other fork patches work — no override options, no base-package docs dir:

- edit `packages/coding-agent/docs/*.md` in place (fork or replace the pages
  listed in the table, add the new bot docs next to them);
- edit the `<docs>` section prose in
  `packages/coding-agent/src/core/system-prompt.ts` so it names the bot
  layout;
- bots run from this checkout (`$PI_SOURCE_DIR`), so `getDocsPath()` already
  resolves to the edited docs.

Edited/replaced set: `configuration.md`, `settings.md`, `packages.md`,
`extensions.md`, `skills.md`, `environment-variables.md`, plus replacement
pages for `models.md` / `providers.md` / `custom-provider.md`, and the new
`self-config.md`, `memory.md`, `registry.md`.

Cost: upstream rebases conflict on edited docs. Keep this list current and
re-apply the edits after `git fetch upstream && git rebase upstream/main dev`.

## 4. Enforcement recap (what backs the docs)

| Claim in docs | Backing |
|---|---|
| model is fixed | `PI_ADMIN_SETTINGS` file (written by the reconciler) + admin merge + `pi.models.select` clamp + no UI picker |
| mandatory packages come back | reconciler installs the union on every start |
| tool floor cannot be removed | admin merge on `defaultTools` (built-ins) + always-on extension tools |
| shared files are service-owned | currently convention only; read-only mount/uid boundary later (container) |
| setup runs once | `.setup` marker until the `init` commit; the commit clears it and writes `.apply`; kickoff sends `/skill:self-config` |
| edits apply on commit | post-commit hook (config-surface paths) + `.apply` marker + bridge watcher restart |
| SOUL is the identity | memory extension builds the preamble and the `<behavior>` section from SOUL.md / BEHAVIOR.md |
| extensions must use the supported subset | experimental harness behavior (document, do not promise more) |
