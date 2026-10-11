# Local setup (NixOS)

The generic setup in `installation.md` assumes a global npm install and lets
Puppeteer download its own Chrome. Neither works as-is on NixOS: the npm
global prefix is read-only, and a downloaded Chrome will not run against the
system's libraries. This file records what actually works here.

Source: copied from `ChromeDevTools/chrome-devtools-mcp`
(`skills/chrome-devtools-cli`), Apache-2.0, version 1.10.1, fetched
2026-09-29. `SKILL.md` and `installation.md` are upstream; this file is ours.

## Install (once)

```sh
bun install -g chrome-devtools-mcp@1.10.1     # pin the version
export PATH="$HOME/.bun/bin:$PATH"            # bun's global bin
```

The package ships two binaries: `chrome-devtools` (the CLI) and
`chrome-devtools-mcp` (the MCP server). Only the CLI matters here.

`~/.bun/bin` is not on `PATH` by default. A symlink in `~/.pi/agent/bin`
(already on `PATH` for shells and for pi's own processes) is enough:

```sh
ln -sfn "$HOME/.bun/bin/chrome-devtools" "$HOME/.pi/agent/bin/chrome-devtools"
```

## Start the browser

```sh
CHROME=/nix/store/g0yvxs8p2ijrvmxpd5mim1ni0fyk9bnh-chromium-154.0.8037.57/bin/chromium

chrome-devtools start --headless=true --isolated \
  --executablePath "$CHROME" --chromeArg=--no-sandbox
```

- `--executablePath` is the nixpkgs Chromium. Do not rely on the default
  channel: Puppeteer's download does not run here.
- `--chromeArg=--no-sandbox` is required for this Chromium build.
- `--isolated` gives a throwaway profile, cleaned up on exit. Drop it when a
  login should persist (`~/.cache/chrome-devtools-mcp/chrome-profile`).
- `--headless=false` shows the window; useful when watching what the agent
  does.

To drive an already-running Chromium instead of one this CLI launches, start
it with `--remote-debugging-port=9222` and pass
`--browserUrl http://127.0.0.1:9222` (see the upstream
`docs/advanced-usage.md#connecting-to-a-running-chrome-instance`).

## Verified working

2026-09-29, CLI 1.10.1, nixpkgs Chromium 154.0.8037.57: `start`, `status`,
`list_pages`, `new_page`, `take_snapshot` (UIDs usable for `click`/`fill`),
`evaluate_script`, `list_console_messages`, `take_screenshot`, `stop`.

Quirk of this Chromium build: the text snapshot splits plain text into
per-character `StaticText` nodes (`uid=1_1 StaticText "T"`, …). Interactive
elements — links, buttons, inputs — are still single nodes with usable UIDs,
so the normal workflow is unaffected.

## Driving the apiary web app

```sh
bun run build
packages/connector/bin/apiary-web &                                  # 127.0.0.1:8787
chrome-devtools new_page http://127.0.0.1:8787
chrome-devtools take_snapshot <pageId>
chrome-devtools take_screenshot <pageId> --filePath /tmp/app.png
chrome-devtools emulate <pageId> --colorScheme dark --viewport 1280x800
```

`emulate` and the other per-page overrides persist for the daemon session, so
set the theme/viewport once and then act. The repo's smoke scripts
(Chromium + `playwright-core` over CDP, kept outside the repo) remain the
batch option; this CLI is the interactive one. The frontend-design skill has
the design rules to check against.
