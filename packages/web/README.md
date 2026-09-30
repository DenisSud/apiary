# @pi-bots/web — the browser client

The app served by `packages/connector/bin/pi-bots-web`: a bot list, one open session, and the
transcript of that session. It talks to a bot's pi server through the bridge's
WebSocket using the same client stack as the TUI (`pi-client` + Chord service
facades), so there is no second protocol.

Plain TypeScript, one esbuild bundle, no framework. The design reference is
[`design/plan.html`](design/plan.html) (open it in a browser); the tokens it
defines live at the top of `src/style.css`.

## Run

```bash
bun install                 # once, repo root
bun run build               # bundle to packages/web/dist
packages/connector/bin/pi-bots-web  # http://127.0.0.1:8787
```

In a devenv shell: `build`, `web`, `web-watch` (rebuild on change), `test`.
`build.mjs` needs the pi source checkout (`PI_SOURCE_DIR`, default `~/dev/pi`):
`@pi/fork/*` imports are source modules there, and the pi packages are mapped
to the built copies this repo depends on. It also copies `index.html`,
`style.css` and the blobatar CSS into `dist/`.

## Files

| file | responsibility |
|---|---|
| `main.ts` | composition root: DOM handles, app state (open session, bot list, busy flag), event wiring, the session actions, the onboarding/empty-state swap, the setup watcher |
| `types.ts` | the snapshot vocabulary (`BotSummary`, `BotDetail`, `Entry`, `Operation`, `TranscriptSnapshot`, `QueuedItem`) and pure readers over it (`textOf`, `blockText`, `messageBlocks`, `queuedMessages`) |
| `session.ts` | one session over the bridge: WebSocket → `ByteTransport` → `Client`, activation, create-if-unknown + attach, snapshot subscription, `prompt`/`steer`/`abort`/`compact`, and the management calls (`listBots`, `createBot`, `reloadBot`) |
| `onboarding.ts` | the first-run / new-bot view: provider login (both methods), name, create |
| `onboarding-core.ts` | the onboarding's pure core: name rule, kickoff message, provider order/methods/status |
| `auth.ts` | the provider-login client: `GET /api/auth/providers`, start a login, the frame protocol over one WebSocket |
| `turns.ts` | the transcript's pure structure: entries → turns → pieces → bubbles, and the block signatures |
| `skill-block.ts` | reads the `<skill …>` block the service writes into a user message, for the chip rendering |
| `transcript.ts` | the transcript view: settled blocks, the live bubbles, tool rows, notes, append-only rendering |
| `tools.ts` | tool rows: icon + one-line call, state glyph, duration, result block, call/result pairing |
| `stream.ts` | the streaming answer: settled prefix as markdown, the tail revealed in chunks |
| `scroll.ts` | following the end: the `pinned` state, content observers, the jump action |
| `composer.ts` | the composer pill: auto-grow, cap, expand toggle, send button state |
| `panel.ts` | the bot panel: sidebar or drawer, one owner of the layout decision |
| `bots.ts` | the bot list rows: blobatar, name, state, the open row highlighted |
| `markdown.ts` | markdown rendering for bot output |
| `blob.ts` | the blobatar as inline SVG, optionally following the pointer |
| `index.html` | the static shell (all element ids `main.ts` looks up) |
| `style.css` | tokens, both themes, the components, motion |
| `test/core.test.ts` | the pure core: grouping, pieces, bubbles, readers, formatters, the pin decision |
| `test/onboarding.test.ts` | the onboarding core: name rule, kickoff, provider ordering and lines |
| `test/skill-block.test.ts` | the skill block reader |

## Data flow

```
browser                    bridge (node)                bot pi server
/ws?bot&session  --ws-->  byte relay  --unix socket-->  session worker
   |                                                        |
   +-- session.ts: Client + Chord facades  <--- framed CBOR -+
        management.create/attach, transcript.state.subscribe
   |
   +-- main.ts renderSnapshot(snapshot) --> transcript.render(snapshot)
```

Everything above `session.ts` sees only a `TranscriptSnapshot`; nothing else
knows the wire exists. The snapshot is the source of truth for the busy state:
`operation` is present while a turn runs (`status` is `"open"` or
`"aborting"`, never `"running"`), absent while idle.

Actions go back through `AgentController`: `prompt` when idle, `steer` while a
turn runs, `requestAbort(operation.id)` for stop, `compact` while idle.

## Onboarding

First run (no bots in `PI_BOTS_HOME`) swaps the main area for the onboarding
view: provider login over the bridge auth proxy, then a name, then create. It
opens again from the sidebar `+` and the no-session empty state. On create,
`main.ts` opens a fresh session and sends the first-setup prompt through the
self-config skill (`kickoffPrompt` in `onboarding-core.ts`); the transcript
renders it as a skill chip.

While the active bot is in setup (or has an apply pending) `main.ts` polls
`GET /api/bots` every 3 s and shows a chip on the session bar. The bridge's
apply watcher skips bots with an attached client, so once `setup` flips and
the turn settles the client applies the marker itself: `POST reload`, then
re-attach the same session (`maybeApply`).

## Rendering rules

The transcript is **appended to, not rebuilt**. `transcript.ts` groups the
entries into blocks (a user message, a turn, a note), gives each a signature
(the ids it contains), and re-renders only from the first block whose
signature changed. A full `reset()` happens on session switch and compaction,
because the transcript is replaced there. Two consequences worth keeping:

- An open `<details>` survives every later snapshot; new nodes get the
  `enter` class once, so the fade-in does not replay.
- The live slot is reconciled bubble by bubble: bubbles only append within a
  turn, text streams in place, and the thinking `<pre>` is updated
  node-by-node. No full swaps, so nothing blinks.

Other rules:

- A turn is everything between two user messages; its pieces group into
  bubbles — the work of a phase and the message it produced (`turns.ts`).
  Live, a bubble shows its trace ("Working", thinking, tool rows) and
  collapses it the moment the text streams in; work after a message opens a
  new bubble. Settled, only the message bubbles remain — traces are not kept
  in the transcript (the session tree will show them later).
- A skill invocation (`<skill …>` in the user message) renders as a chip with
  the name, the description from its frontmatter on hover.
- A tool call and its result are one row, paired by `toolCallId` whatever
  order they arrive in (`tools.ts` caches results until the call shows up).
  A running tool that has no transcript message yet comes from
  `operation.runningTools`; an orphaned result gets its own panel.
- Queued steers/follow-ups come from `snapshot.queues`; abort puts their text
  back in the composer, since the abort event payload is not in the reducer's
  snapshot.
- Following the end is state, not animation: `pinned` turns false the moment
  the reader moves up (our own follow-scrolls only ever increase `scrollTop`),
  content growth is watched with `ResizeObserver`, and the jump button is the
  only smooth scroll.
- Markdown drops raw HTML (`marked` renderer) and rewrites links after
  parsing: `target="_blank"`, `rel="noopener noreferrer"`, unsafe schemes
  unwrapped.

## Design

`design/plan.html` is the living design reference (HIG-grounded: one accent,
one type ramp, one easing curve, 4px grid, radius scale); `design/` also keeps
one-off comparison pages (`tool-call-status.html`). The rules themselves, their
rationale and the current status are in the deployment's web doc; the rules a
change must respect are in `.pi/skills/frontend-design/SKILL.md`. Implemented in
`style.css`: the token sheet and dark mode (`prefers-color-scheme`, no in-app
toggle), the type ramp, the accent/error/warn separation, `--ease` +
`--dur-in`/`--dur-out` on every transition, inline SVG icons, the mobile
drawer below 650px.

Not implemented from the plan: the rAF-glide scroll (the follower writes
`scrollTop` instantly on purpose — a glide toward a moving target lags and
fights the reader), the masked "live window" for working text with its
`thought for X s` collapse, and the separate icons module.

## Tests

```bash
bun run test                # from the repo root: connector + web
node --test test/*.test.ts  # this package alone
```

`test/core.test.ts` covers the pure core with no DOM. The rest is verified by
hand in a browser against a real bot (Chromium + playwright-core scripts kept
outside the repo).
