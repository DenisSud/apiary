---
name: frontend-design
description: Use when working on the web UI in packages/web — layout, styling, components, motion, colors, or reviewing a change against the project's design system. Covers the token set, the rules that must not be broken, and how to verify visually.
---

# Frontend design in pi-bots

The web client (`packages/web`) is plain TypeScript plus one CSS file, no
framework, one esbuild bundle. The design is deliberate: Apple-HIG discipline,
one accent, one type ramp, one motion vocabulary.

Deeper context, when the change touches it — not a pre-flight checklist:

- `packages/web/design/plan.html` — the living reference. Open it when a
  component's target form is unclear; the tokens at the top are the ones to
  copy.
- `packages/web/README.md` — module map, data flow, rendering invariants.
- `~/Bots/docs/web.md` — rationale behind the rules and the current status
  (the maintainer's fleet docs, outside this repo).

## The system

Tokens live at the top of `packages/web/src/style.css` (`:root` plus a
`prefers-color-scheme: dark` mirror). Use them. Never write raw hex, font
sizes, radii, or durations inside a component rule.

- **Color.** `--accent` is the only interactive color (buttons, links, live
  activity, focus rings). Status colors (`--ok`, `--error`, `--warn`) describe
  processes only and never style something clickable. Dark values are
  re-lifted, not inverted. Color is never the only signal — every state also
  carries text.
- **Type.** System font stack; the ramp is 11/12/13/15/17/20/28. Transcript
  body 15, tool steps 12 mono, chrome 13. Do not invent in-between sizes.
- **Shape.** Radius scale 6/12/16/999; spacing on the 4px grid; separate flat
  surfaces with the hairline `--border`, not shadows. Elevation only for what
  genuinely floats (the jump pill, the mobile drawer).
- **Motion.** One curve `--ease`, `--dur-in` for entering, `--dur-out` for
  leaving. Motion plays only when a state actually changed; hover is an
  instant color shift, never a travel. `prefers-reduced-motion` collapses
  everything.

## Non-negotiables

These were decisions, not accidents. Change them only when the maintainer asks.

- **The composer has no focus treatment.** Resting and focused are
  pixel-identical. Do not add a ring or border on focus.
- **The composer floats over the transcript.** Its footprint is published as
  `--composer-space` and the transcript's bottom padding uses it. Never
  hardcode that padding.
- **One assistant box per turn.** Live: a grey block whose summary is
  "Working"/"Waiting" with a spinner, collapsible while it runs. Settled: the
  same block collapsed to "worked for X s". Text in a message that also
  carries tool calls is an explainer row inside the trace; text alone is the
  answer below it.
- **Tool rows are quiet.** Glyph, name, a one-line argument, the duration on
  hover, a state glyph: a check when done, a spinner while running, red only
  on error.
- **The panel takes space or pushes the chat.** At ≥651px it is a sidebar and
  the chat centres in what is left; below, it is a drawer that translates the
  chat right under a scrim. The breakpoint lives in the CSS comment *and* in
  `OVERLAY_QUERY` in `panel.ts` — keep them in sync.
- **Following the end is state, not animation.** `pinned` flips the moment the
  reader moves up; our own follow-scrolls write `scrollTop` instantly. Smooth
  scrolling is reserved for the explicit jump.
- **No new dependencies** for the app: vanilla DOM + `marked` + `blobatar`,
  bundled by esbuild (`build.mjs`). No React, no CSS framework, no icon
  package — icons are inline SVG paths.

## Work

```bash
bun run build          # bundle to packages/web/dist
packages/connector/bin/pi-bots-web  # serve app + bridge on 127.0.0.1:8787
# in a devenv shell: build, web, web-watch
```

Verify what the change actually affects, with the smallest check that can
catch the class of bug:

- Pure logic: `bun run test` (the pure core, no DOM).
- Layout, state, interaction: the real app — the `chrome-devtools` CLI (see
  `.pi/skills/chrome-devtools-cli/`; local setup in its `references/local.md`)
  for one-off checks; Chromium + playwright-core scripts (kept outside the
  repo) over CDP for batch runs.
- Color/scheme changes: the dark render. Motion changes:
  `prefers-reduced-motion`. A token or copy tweak needs one screenshot, not a
  tour of states the change cannot affect.

Emulation overrides (`Emulation.setDeviceMetricsOverride`, `setEmulatedMedia`)
are per-connection — set them and act in the same session.

Gotchas that have bitten:

- `.live` is `display: contents` — it has no box, so a ResizeObserver on it
  never fires. Observe its children.
- A `<details open>` we create still queues one `toggle` event; `openedByUs`
  exists so our own open state does not unpin the reader.
- A shorthand `padding` in a media query silently resets a load-bearing
  longhand (the phone block once dropped the composer's clearance).
