# pi-bots

Specialized pi agents as one monorepo. The base setup (`pi-setup`) is shared by
every agent; each bot directory here is a pi package that layers skills and
instructions on top of it.

## Bots

| bot | package | what it adds |
|---|---|---|
| `dev` | `dev/` | coding skills + the minimalism/code rules |

## Use

```bash
pi                      # general agent (pi-setup only)
pi --bot dev            # dev bot
pi-bot dev -p "..."     # same, non-interactive: scripts, cron, subagents
```

`pi --bot <name>` is a fish function installed by `install.sh`; it expands to
the `pi-bot` wrapper, which runs:

```
pi -e <repo>/<name> --append-system-prompt <repo>/<name>/APPEND_SYSTEM.md \
   --session-dir ~/.pi/agent/sessions/<name> "$@"
```

- `-e` loads the bot package (its `skills/`) in addition to the global setup:
  a bot is *general + its extras*, nothing is removed.
- `APPEND_SYSTEM.md` is the bot's role and instructions.
- sessions are kept per bot under `~/.pi/agent/sessions/<name>`.
- model and thinking come from the shared settings (no per-bot override yet).

## Add a bot

1. `mkdir <name>` with `package.json` (`"pi": {"skills": ["./skills"]}`),
   `skills/`, and `APPEND_SYSTEM.md`.
2. Test: `pi --bot <name>` (or `pi-bot <name> -p "..."`).

## Install per machine

```bash
git clone ssh://git@git.sudakov.site:2223/DenisSud/pi-bots.git ~/dev/pi-bots
~/dev/pi-bots/install.sh
```

`PI_BOTS_DIR` overrides the checkout location for the wrapper.

## Layout

```
├── bin/pi-bot          # sh shim: bot dir -> pi flags
├── fish/pi.fish        # fish function: pi --bot <name>
├── install.sh          # symlinks both into place
└── dev/                # the dev bot (a pi package)
    ├── package.json
    ├── APPEND_SYSTEM.md
    └── skills/
```
