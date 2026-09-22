# pi-bots

Denis's complete pi setup as one monorepo: the **base** (skills, extensions,
shareable settings) plus **bot** packages that layer specializations on top.

Supersedes the old `pi-setup` repo (merged 2026-09-22; its git history was
grafted onto this one).

## Layout

```
├── package.json          # base pi package manifest (pi-package)
├── settings.json         # shareable settings (see "Settings")
├── install.sh            # settings merge, AGENTS.md link, package install, bot wrapper
├── global/AGENTS.md      # base global instructions, symlinked to ~/.pi/agent/AGENTS.md
├── extensions/           # base extensions
├── skills/               # base skills (general-purpose)
├── bin/pi-bot            # sh shim: bot dir -> pi flags
├── fish/pi.fish          # fish function: pi --bot <name>
└── bots/
    └── dev/              # the dev bot (a pi package)
        ├── package.json
        ├── APPEND_SYSTEM.md
        └── skills/       # coding skills
```

## Bots

| bot | what it adds |
|---|---|
| `dev` | coding skills + the minimalism/code rules |

```bash
pi                  # base agent (base extensions + skills)
pi --bot dev        # base + dev
pi-bot dev -p "..." # same, for scripts, cron, subagents
```

`pi --bot <name>` is a fish function installed by `install.sh`; it expands to
the `pi-bot` wrapper, which runs:

```
pi -e <repo>/bots/<name> --append-system-prompt <repo>/bots/<name>/APPEND_SYSTEM.md \
   --session-dir ~/.pi/agent/sessions/<name> "$@"
```

- `-e` loads the bot package on top of the base: a bot is *base + its extras*.
- sessions are kept per bot under `~/.pi/agent/sessions/<name>`.
- model and thinking come from the shared settings.

## Base

Extensions: `sysinfo` (machine facts injected into the system prompt),
`consult` (frontier-model second opinion), `web-search` (web_search/web_fetch
via a local SearXNG + trafilatura/pdftotext), `ptc` (programmatic tool
calling), `security` (Bitwarden secrets profiles, output redaction,
credential-store guards).

Skills: cron-jobs, grilling, handoff, homelab, memory-review, research,
subagents, writing-great-skills. Coding skills live in `bots/dev`.

`web-search` expects a SearXNG instance (`SEARXNG_BASE_URL`, default
`http://127.0.0.1:8888`) and the `trafilatura` + `pdftotext`/`pandoc` binaries
for `web_fetch` (the NixOS module lives in the nixos-config repo).

## Install per machine

```bash
git clone ssh://git@git.sudakov.site:2223/DenisSud/pi-bots.git ~/dev/pi-bots
~/dev/pi-bots/install.sh
```

The installer registers the checkout as a **local path** (`pi install
/path/to/pi-bots`): base edits apply on `/reload` or restart, no push needed to
test. Bots load from the same checkout. `PI_BOTS_DIR` overrides the location for
the wrapper.

### Settings

`settings.json` ships defaults (`defaultModel`, `defaultProvider`,
`defaultThinkingLevel`, `hideThinkingBlock`, `theme`). `install.sh` merges them
into `~/.pi/agent/settings.json`: your existing keys **win**, `packages` is a
**union**, and `auth.json` / `models.json` / `models-store.json` are **never
touched**.

## Add a bot

1. `mkdir bots/<name>` with `package.json` (`"pi": {"skills": ["./skills"]}`),
   `skills/`, and `APPEND_SYSTEM.md`.
2. Test: `pi-bot <name> --no-session -p "List the skills available to you."`

## Development

Register the checkout as a local path and edits apply on `/reload` or restart.
Commit and push normally.
