# AGENTS.md

Operating notes for agents working in this repo.

## What this repo is

Specialized pi agents: each top-level dir with a `package.json` is a bot
package loaded via `-e` by the `pi-bot` shim. `install.sh` symlinks
`bin/pi-bot` into `~/.pi/agent/bin/` and `fish/pi.fish` into
`~/.config/fish/functions/`.

## Hard rules

- Bots are additive: a bot adds skills/instructions on top of the shared
  `pi-setup` package. Never duplicate shared skills here.
- `APPEND_SYSTEM.md` is rendered verbatim into the system prompt — phrasing is
  load-bearing, edit deliberately.
- No secrets in this repo. Credentials live in Bitwarden and reach commands only
  through the `security` extension's secrets profiles.
- Skills are markdown; no npm dependencies.

## Verify

- Wrapper: `fish -c 'pi --bot dev --version'`.
- Real load: `pi-bot dev --no-session -p "List the skills available to you."`
  The bot's skills should appear; skills moved out of `pi-setup` should not.
