# Open WebUI, dissected — what a great agent web client should steal

Research report for `packages/web`. The source studied is the local
`~/dev/open-webui` checkout (`0.11.4`, commit `8bd8b4fac`). File links are
relative to this file (`docs/` → `../../open-webui/...`).

The goal is not to clone Open WebUI. pi-bots is **not** a multi-model chat
product — it is an always-on agent console. One agent, one session, one
conversation with something that runs tools, for a long time, on your behalf.
That reframing decides what is worth taking.

The report is not neutral about Open WebUI. Two pushbacks run through it, and a
reader who takes away only the checklist should take these too.

## Two pushbacks, up front

**1. pi-bots already does the two hardest structural things better — do not
replace them with Open WebUI's versions.**

- The transcript is append-only (block signatures, patch from the first changed
  block). Open WebUI rebuilds the whole list on every change and patches it
  with rAF throttling and `content-visibility` virtualization to survive the
  cost. pi-bots' approach is more correct: an open `<details>` survives every
  snapshot, and nodes do not blink. Keep it (see §2.1).
- Following the end is a `pinned` state machine in `scroll.ts`. Open WebUI uses
  a 50px distance buffer plus a double-rAF scroll hack. The buffer re-pins too
  eagerly and the hack exists only to paper over its own re-layout. Keep the
  state machine; take nothing from §3 except the MUI jump-with-count idea.

The corollary: Open WebUI's rendering code is a **cautionary tale about the
cost of not solving these two problems**, not a design to port. Several of its
"fixes" (rAF-throttled full rebuilds, `content-visibility`, the double-rAF
scroll) exist only to make the weaker structure tolerable.

**2. Most of Open WebUI's size is feature sprawl and a dual-input path — the
value is ~15 small behaviours, not its architecture.**

`Chat.svelte` is 4,684 lines and `MessageInput.svelte` 2,786, because they
carry model selection, RAG, tool servers, artifacts, a terminal dock, voice,
rich-text input alongside a plain textarea, and dozens of modals. None of that
is the agent console. The parts that actually make it feel right — tool-row
state, inline approval, collapsing reasoning, copy/collapse code, shimmer
status, IME handling, Esc-to-stop, paste-as-file — are each small and mostly
framework-independent. Steal those; ignore the architecture that surrounds
them. §12 lists what to refuse explicitly.

---

## 0. Reading the source: what I looked at

Open WebUI's chat surface, and the parts that carry the feel:

| area | files |
|---|---|
| list, scroll, virtualization | [`Messages.svelte`](../../open-webui/src/lib/components/chat/Messages.svelte) |
| one message, role switch, a11y | [`Messages/Message.svelte`](../../open-webui/src/lib/components/chat/Messages/Message.svelte) |
| markdown + streaming lex | [`Messages/Markdown.svelte`](../../open-webui/src/lib/components/chat/Messages/Markdown.svelte), [`ContentRenderer.svelte`](../../open-webui/src/lib/components/chat/Messages/ContentRenderer.svelte) |
| assistant message, status, actions | [`ResponseMessage.svelte`](../../open-webui/src/lib/components/chat/Messages/ResponseMessage.svelte) |
| live status timeline | [`ResponseMessage/StatusHistory.svelte`](../../open-webui/src/lib/components/chat/Messages/ResponseMessage/StatusHistory.svelte) |
| tool call row | [`common/ToolCallDisplay.svelte`](../../open-webui/src/lib/components/common/ToolCallDisplay.svelte) |
| code block | [`Messages/CodeBlock.svelte`](../../open-webui/src/lib/components/chat/Messages/CodeBlock.svelte) |
| composer | [`MessageInput.svelte`](../../open-webui/src/lib/components/chat/MessageInput.svelte) |
| empty state / suggestions | [`Placeholder.svelte`](../../open-webui/src/lib/components/chat/Placeholder.svelte), [`Suggestions.svelte`](../../open-webui/src/lib/components/chat/Suggestions.svelte) |
| layout, sidebar, mobile | [`layout/Sidebar.svelte`](../../open-webui/src/lib/components/layout/Sidebar.svelte), [`common/MobileSwipePanel.svelte`](../../open-webui/src/lib/components/common/MobileSwipePanel.svelte) |
| global keys | [`routes/(app)/+layout.svelte`](<../../open-webui/src/routes/(app)/+layout.svelte>) |
| shared CSS (shimmer, fade) | [`src/app.css`](../../open-webui/src/app.css) |

External grounding: NN/g [10 Guidelines for Designing Your Site's AI
Chatbots](https://www.nngroup.com/articles/ai-chatbots-design-guidelines/)
(esp. #4 suggested prompts, #6 progressive disclosure, #7 *do not autoscroll
users to the end of a streamed response*), MUI X Chat
[Scrolling](https://mui.com/x/react-chat/behavior/scrolling/) (bottom buffer,
jump affordance with unseen count, hidden live region), MUI X
[Reasoning](https://mui.com/x/react-chat/ai-and-agents/reasoning/), and Open
WebUI's own [reasoning-model docs](https://docs.openwebui.com/features/chat-conversations/chat-features/reasoning-models/).

A note on comparison: `packages/web` already implements several things Open
WebUI does, and in two cases does them *better* (append-only transcript,
`pinned` scroll state). Those are marked **have** below; the useful output is
the gap.

---

## 1. The five qualities that make it feel right

Open WebUI is not elegant inside — `Chat.svelte` is 4,684 lines and
`MessageInput.svelte` is 2,786. It feels right anyway because of a handful of
behaviours, and every one of them is about *honesty and control during a slow,
non-deterministic operation*:

1. **Latency is the product.** The response is streamed, and the wait is made
   informative instead of blank. Typing/working indicators, a stop button, and
   live status text ("Searching the web", "Retrieved 4 sources").
2. **Never fight the reader.** Follow the end only while the reader is at the
   end; the moment they move up, stop. (NN/g #7.)
3. **Progressive disclosure.** The default view is short and quiet; detail —
   tool input/output, reasoning, sources, code internals — is one click away
   and collapses back in place.
4. **Quiet chrome, loud content.** Transcript body at 15px, chrome at 13px,
   tool rows at 12px mono; actions appear on hover; a single accent colour.
   The interface recedes so the answer can be the bright thing.
5. **State is visible and reversible.** Busy, stopped, errored, queued,
   waiting-for-approval all have text; and send, stop, retry, edit, queue,
   approve/deny are all available at the point of the state.

Everything below is a mechanism for one of those.

---

## 2. Transcript rendering

### 2.1 Rhythm and virtualization

Each message row is a fixed measure, centred, with the author and actions in
the layout but not the content:

```svelte
<!-- Messages/Message.svelte:47 -->
<div role="listitem"
     class="flex flex-col justify-between px-3.5 mb-3 w-full
            {$settings?.widescreenMode ? 'max-w-full' : 'max-w-[58rem]'} ...">
```

The scrolling list is a semantic log, not a div sea:

```svelte
<!-- Messages.svelte:497 -->
<ul role="log" aria-live="polite" aria-relevant="additions" aria-atomic="false">
```

Off-screen messages are culled with **browser-native virtualization** rather
than JS mount/destroy — with a WebKit escape hatch because Safari's
`content-visibility` paints blank on-screen rows (their issue #26712):

```svelte
<!-- Messages/Message.svelte:115 -->
<style>
  .message-virtualized { content-visibility: auto; contain-intrinsic-size: auto 150px; }
</style>
<!-- and, in the script, isWebKit disables it on Safari -->
```

**Steal:** the `role="log"` pattern (cheap, big a11y win) and the measured
column. **Defer:** `content-visibility` virtualization — pi-bots transcripts
are one session and the append-only renderer does not rebuild nodes; add it
only if long sessions start janking. pi-bots **have** the append-only
signature renderer, which is strictly better than Open WebUI's full-list
rebuild for correctness (open `<details>` survives).

### 2.2 Streaming without layout thrash

Two throttles keep streaming from melting the main thread. The markdown lexer
runs at most once per frame while a message is not done:

```js
// Messages/Markdown.svelte:80
const updateHandler = (content) => {
  if (content) {
    if (done) { cancelAnimationFrame(pendingUpdate); parseTokens(); }
    else if (!pendingUpdate) {
      pendingUpdate = requestAnimationFrame(() => { pendingUpdate = null; parseTokens(); });
    }
  }
};
```

and the whole message-list rebuild is likewise rAF-throttled, with structural
changes (`currentId`) rebuilt immediately:

```js
// Messages.svelte:118
const currentIdChanged = currentId !== lastCurrentId;
if (currentIdChanged) { cancelAnimationFrame(pendingRebuild); buildMessages(); }
else if (_messages) { if (!pendingRebuild) pendingUpdate... buildMessages(); }
```

The per-token fade is a 100ms opacity keyframe, not a per-character animation:

```css
/* src/app.css:261 */
@keyframes fade-in-token { from { opacity: 0 } to { opacity: 1 } }
.fade-in-token { animation: fade-in-token 100ms ease-out; }
```

**Have (better):** `packages/web/src/stream.ts` re-renders only the settled
prefix as markdown and reveals just the un-settled tail, word by word; a
rewrite (not an append) re-renders whole with no animation. That is a tighter
contract than re-lexing the whole message each frame. Nothing to take here
except the lesson to keep the tail bounded.

### 2.3 Reasoning / thinking

Open WebUI parses reasoning two ways (tags in `content`, or
`reasoning_content`/`thinking` deltas) and renders it as a
`<details type="reasoning">` — a collapsible "Thought" section above the
answer. The group component keeps consecutive reasoning/tool details from
becoming a wall:

```svelte
<!-- Messages/Markdown/MarkdownTokens.svelte:63 -->
const GROUPABLE_DETAIL_TYPES = new Set(['tool_calls', 'reasoning', 'code_interpreter']);
```

**Steal the *shape*, not the wire handling.** pi-bots already receives
thinking as a separate stream and updates the `<pre>` node-by-node, and the
"Working/Waiting" trace bubble already collapses when text arrives (see
`transcript.ts`). Two refinements worth taking:

- label the collapsed trace with **elapsed time** ("Thought for 6 s") instead
  of a bare spinner, so a long think reads as work, not a hang;
- keep reasoning **out of the settled transcript** (pi-bots already does) and
  let the session tree own the full trace (already the plan).

### 2.4 Tool calls — the most reusable component

This is where an agent console differs from a chat app, and Open WebUI's
`ToolCallDisplay.svelte` is the best-considered piece in the repo. One row
carries a full state machine:

```svelte
<!-- common/ToolCallDisplay.svelte:211 -->
{#if isActive}      <Spinner/>                 <!-- "shimmer" text while preparing/executing -->
{:else if isRejected}<XMark/>  red
{:else if isError}  <XMark/>   red
{:else if isDone}   <CheckCircle/> emerald
{:else}             <WrenchSolid/> grey
{/if}
```

The label swaps by state — `Preparing {{NAME}}…`, `Executing {{NAME}}…`,
`Allow {{NAME}}?`, `View Result from {{NAME}}` — and **approval is inline**,
not a modal:

```svelte
<!-- common/ToolCallDisplay.svelte:268 -->
<button class="tool-call-allow-button" on:click|stopPropagation={() => onResolve(true)}>Allow</button>
<button class="tool-call-deny-button"  on:click|stopPropagation={() => onResolve(false)}>Deny</button>
```

Expanding reveals Input (parsed as key/value rows when it is an object) and
Output, and long output is clamped with an explicit escape hatch:

```js
// common/ToolCallDisplay.svelte:44
const RESULT_PREVIEW_LIMIT = 10000;
// … "Show all ({{COUNT}} characters)"
```

**Steal all of it.** For pi-bots this maps onto `tools.ts` + the transcript:
the quiet row already exists (glyph, one-line arg, duration, state glyph), but
the piece pi-bots does not yet have is the **inline approval affordance for
guarded tool calls** — which is exactly the security guard's surface. Put
Allow/Deny in the row, with `aria-expanded` on the disclosure, and clamp
results with "Show all (N chars)" rather than dumping 10k of stdout.

### 2.5 Code blocks

Open WebUI's `CodeBlock.svelte` is a small IDE: language label, Edit,
Collapse ("N hidden lines"), Run, Save, Copy (with `Copied` state), Preview
for html/svg, and a dedicated diff renderer.

```svelte
<!-- Messages/CodeBlock.svelte:112 -->
<button class="copy-code-button" on:click={copyCode}>{copied ? 'Copied' : 'Copy'}</button>
```

**Steal:** Copy-with-confirmation, Collapse for long blocks, the language
label, and "N hidden lines". **Skip:** Run (Pyodide/Jupyter), Save-back into
the message, Preview, Diff — none of that is the agent's job here, and each
is a big dependency. pi-bots' `markdown.ts` is 24 lines today; copy + collapse
are the two that will be felt.

### 2.6 Sources

`WebSearchResults.svelte` renders a collapsible list with favicon, title,
`line-clamp-1`, and a Google-query link. For an agent that has the
`web-search` registry package, this is directly useful — a tool result can
render as sources rather than raw JSON. **Steal** the row (favicon + title +
clamp), keep it collapsed by default.

---

## 3. Scroll and follow

Open WebUI uses a distance buffer: it re-enables `autoScroll` when within
50px of the end, and scrolls with a double-rAF hack to survive
`content-visibility` re-layout:

```js
// Messages.svelte:145
const scrollToBottom = () => {
  element.scrollTop = element.scrollHeight;
  requestAnimationFrame(() => { element.scrollTop = element.scrollHeight; });
};
// Messages.svelte:186 — the buffer
autoScroll = element.scrollHeight - element.scrollTop <= element.clientHeight + 50;
```

**Have (better):** pi-bots' `scroll.ts` makes following a state machine
(`pinned`), distinguishes browser-caused shrink from the reader moving up, and
observes content *size* with `ResizeObserver` instead of hooking messages. Do
not import the 50px buffer or the double-rAF. NN/g #7 is the external
confirmation of why this matters.

**Steal from MUI, not Open WebUI:** the **jump-to-latest affordance with an
unseen count** and the hidden `role="status"` live region that announces when
a streamed response starts and completes. pi-bots has the jump pill; adding
the unseen count (messages/count) is a small, high-value touch, and the
hidden live region is a cheap a11y improvement for a log that updates itself.

---

## 4. Composer

`composer.ts` already owns the pill (auto-grow, 14-line cap, expand toggle,
send state, no focus treatment). Open WebUI's composer is far larger and
mostly about things pi-bots should not have (rich text via TipTap, model
capability menus, voice, `@`/`#`/`$`/`:` command palettes, skills, MCP tool
pickers, Google Drive). But five *small correctness and forgiveness* details
are worth porting:

**1. IME guard.** Enter must not send while a CJK input method is composing,
including Safari's compositionend-then-keydown ordering:

```js
// MessageInput.svelte:706
function inOrNearComposition(event) {
  if (isComposing) return true;
  if (isSafari && Math.abs(event.timeStamp - compositionEndedAt) < 500) {
    compositionEndedAt = -2e8; return true;
  }
  return false;
}
```

**2. Enter vs Shift+Enter**, with a `ctrlEnterToSend` escape for users who
want newline-first. pi-bots should ship Enter=send / Shift+Enter=newline and
leave the toggle for when someone asks.

**3. ArrowUp on an empty composer edits the last user message** — a
universally loved affordance:

```js
// MessageInput.svelte:2121
if (prompt === '' && e.key == 'ArrowUp') {
  e.preventDefault();
  [...document.getElementsByClassName('user-message')]?.at(-1)?.scrollIntoView({block:'center'});
  [...document.getElementsByClassName('edit-user-message-button')]?.at(-1)?.click();
}
```

**4. Escape stops the running turn** (`if (e.key === 'Escape') stopResponse();`).
pi-bots has abort; wire it to Escape.

**5. Large paste becomes a file**, above a threshold, so a 200KB paste does
not wedge the composer (`PASTED_TEXT_CHARACTER_LIMIT`, `MessageInput.svelte:2192`).

Also: **queued messages** are first-class rows with Send now / Edit / Delete
([`QueuedMessageItem.svelte`](../../open-webui/src/lib/components/chat/MessageInput/QueuedMessageItem.svelte)).
pi-bots already surfaces steers/follow-ups from `snapshot.queues` and restores
text on abort; make sure the row exposes edit/remove, not just read-only text.

**Skip:** rich-text input (the dual textarea/TipTap path is a large share of
that file's complexity), drag-and-drop files (the agent reads its own
filesystem), voice, model/tool pickers.

---

## 5. Live status — the single highest-leverage thing

For a long-running agent, "what is it doing right now" is the whole
experience. Open WebUI has three mechanisms:

- **Status history** — an ordered timeline of actions (`web_search`,
  `knowledge_search`, `sources_retrieved`…) rendered as dots connected by a
  hairline, each with a human sentence and often chips:
  [`StatusHistory.svelte`](../../open-webui/src/lib/components/chat/Messages/ResponseMessage/StatusHistory.svelte),
  [`StatusItem.svelte`](../../open-webui/src/lib/components/chat/Messages/ResponseMessage/StatusHistory/StatusItem.svelte).
- **Shimmer** — the active status line is a moving gradient clipped to text,
  so "in progress" is legible without a spinner in every row:
  ```css
  /* src/app.css:203 */
  .shimmer { background-clip: text; -webkit-text-fill-color: transparent;
             animation: shimmer 1.5s cubic-bezier(0.7,0,1,0.4) infinite; }
  ```
- **Task list** — `TaskList.svelte` shows "3 of 7 tasks completed" with
  per-item check/spinner/cancel and a `max-h-[25vh]` scroll, only while
  something is active.

**Steal:** the shimmer for active status text, the idea of a status
**timeline** (pi-bots' `operation`/`runningTools` already give the data), and
the TaskList for when the agent runs a todo list. This is where the console
feels alive instead of frozen. Keep the rule from `frontend-design`: status
colour describes processes only, never styles something clickable.

---

## 6. Message actions

`ResponseMessage.svelte`'s action row (`:940`+) is a catalogue. Present and
useful: Copy (`copy-response-button`), Edit, Regenerate (with a menu of
models), Retry/Continue, Delete, Fork/branch. Present and skippable here:
Read Aloud, Good/Bad rating, "Save As Copy", insert-into-note, merge
responses, floating selection buttons.

Note the interaction detail: the row is `hover-reveal` except on the last
message, where it is always `visible`:

```svelte
<!-- ResponseMessage.svelte:1093 -->
class="{isLastMessage ? 'visible' : 'hover-reveal'} p-1.5 ..."
```

**Steal:** the small set — **Copy, Retry, Edit, branch/delete** — and the
hover-reveal rule (actions on the last message visible, older ones on hover).
pi-bots has abort but almost no per-message actions today; Copy and Retry are
the first two.

---

## 7. Empty state, onboarding, suggestions

Open WebUI's `Placeholder.svelte` shows an avatar + model name + description
and, underneath, `Suggestions.svelte`: clickable prompts, randomly ordered per
mount, fuzzy-filtered by what is typed (Fuse), animated in with a staggered
waterfall:

```svelte
<!-- Suggestions.svelte -->
<button role="listitem" style="animation-delay: {idx * 45}ms" class="waterfall" …>
```
```css
@keyframes fadeInUp { 0% { opacity:0; transform:translateY(6px) } 100% { opacity:1; transform:none } }
```

NN/g #3/#4 back this: show what the agent can do through example prompts, and
present follow-ups as **buttons**, not text.

pi-bots' first-run onboarding (provider login + name + self-config kickoff) is
already a different and better flow for first run. **Steal for the empty
*established* session:** clickable suggestions drawn from the agent's skills,
and optional after-answer follow-ups (`FollowUps.svelte` presents them as rows
— make them buttons). The waterfall is a nice 200ms touch, cheap in vanilla
CSS.

---

## 8. Layout, responsive, mobile

Open WebUI: sidebar width transitions and a `$mobile` store drives a drawer;
`MobileSwipePanel.svelte` is a genuinely good edge-swipe implementation worth
reading even though pi-bots already has a drawer:

```js
// common/MobileSwipePanel.svelte:4
const UNSAFE_EDGE = 16;      // ignore swipes starting at the screen edge
const SWIPE_SLOP = 8;        // movement before we decide the gesture
const AXIS_RATIO = 1.2;      // horizontal must beat vertical by this ratio
const FLICK_VELOCITY = 0.55; // px/ms — a flick opens/closes regardless of distance
const SETTLE_MS = 210;
```

It also: skips gestures starting on `input, textarea, select, [contenteditable]`,
bails if there is a text selection, bails if an ancestor can scroll
horizontally in the swipe direction, locks page scroll once the gesture is
committed, and honours `prefers-reduced-motion`.

**Steal:** the gesture *policy* (unsafe edge, slop, axis ratio, flick
velocity, skip-on-input, scroll-lock) — this is the difference between a
drawer that feels native and one that hijacks scrolling. pi-bots' `panel.ts`
already owns the sidebar/drawer decision and remembers state per layout;
layer the gesture policy on top. **Skip:** animating sidebar width (janky);
note their `767px` breakpoint differs from the panel's own widths, a small
inconsistency not worth copying.

---

## 9. Accessibility patterns worth lifting

- `role="log" aria-live="polite" aria-relevant="additions"` on the transcript
  (`Messages.svelte:497`).
- A visually hidden `<h2 class="sr-only" id="chat-conversation">` labelling the
  conversation region.
- Every icon-only control has `aria-label` and a `Tooltip`.
- Disclosures carry `aria-expanded`; the status-history toggle is a real
  `<button>` (`StatusHistory.svelte:29`).
- The closed sidebar gets `inert` + `aria-hidden` (`Sidebar.svelte:1124`).
- MUI's pattern of a visually hidden `role="status"` region announcing stream
  start/complete — the best way to make a self-updating log usable by screen
  readers.

**Avoid:** Open WebUI's `div role="button"` + manual `keydown` rows where a
real `<button>` would do (the tool call row is one). Use the element.

---

## 10. Keyboard

The global dispatcher in [`routes/(app)/+layout.svelte`](<../../open-webui/src/routes/(app)/+layout.svelte>)
maps a configurable keymap to actions: focus input, new chat, search, toggle
sidebar/controls, navigate chats up/down, copy last response, copy last code
block, stop, regenerate, allow/deny tool call, open settings, show shortcuts.

**Steal a small fixed set (~6):** focus composer, send/stop, jump to latest,
new session, toggle panel, copy last response. Do not port the configurable
keybinding editor.

---

## 11. Rendering discipline (the performance lessons)

- Throttle all streaming work to one rAF; never re-render synchronously per
  token.
- Don't remount nodes that are still on screen — patch in place (pi-bots
  already does; Open WebUI's `{#key}` blocks are a cautionary tale).
- `overflow-x-auto` every table/code block; `break-words` on the message.
- Give the action row a reserved footprint so hovering does not shift layout.
- Follow content by **size** (`ResizeObserver`), not by new-message events.
- Respect `prefers-reduced-motion` for every entrance/settle.

---

## 12. What *not* to copy

| Anti-pattern | Why |
|---|---|
| 2–5k-line components (`Chat.svelte` 4,684) | Untestable, merge-hostile. pi-bots' one-interface-per-module is the better frame. |
| Two input paths (textarea + TipTap) | Doubles composer complexity for formatting nobody asked for here. |
| Feature sprawl (models, RAG, tools, artifacts, terminal, calls) | pi-bots is one agent; each of these is a product. |
| Heavy deps (CodeMirror, highlight.js, mermaid, katex, pyodide, Fuse, DOMPurify) | pi-bots' no-new-dependency rule is a feature. Inline SVG + `marked` is enough. |
| Toasts for every outcome, version-update toasts, modals | Chrome noise; prefer inline, in-place state. |
| `autoScroll` 50px buffer + double-rAF scroll | pi-bots' `pinned` state is more correct; NN/g #7 says so too. |
| Token in `localStorage` | Not our auth model. |
| `role="button"` divs | Use real buttons. |
| Gray-on-gray that then needs a "high-contrast mode" | Start at accessible contrast. |

---

## 13. Recommended backlog for `packages/web`

Priority order, with the Open WebUI reference and the pi-bots module it lands
in.

**P0 — correctness and control (small, felt immediately)**

1. IME composition guard in the composer keydown —
   [`MessageInput.svelte:706`](../../open-webui/src/lib/components/chat/MessageInput.svelte) → `composer.ts`.
2. `Escape` aborts the running turn → `composer.ts`/`main.ts`.
3. Per-message **Copy** and **Retry** actions, hover-reveal, visible on the
   last message — [`ResponseMessage.svelte:1093`](../../open-webui/src/lib/components/chat/Messages/ResponseMessage.svelte) → `transcript.ts`.
4. **Inline Allow/Deny** on guarded tool rows — [`ToolCallDisplay.svelte:268`](../../open-webui/src/lib/components/common/ToolCallDisplay.svelte) → `tools.ts`.
5. **Copy code** with a `Copied` state and collapse for long blocks —
   [`CodeBlock.svelte:112`](../../open-webui/src/lib/components/chat/Messages/CodeBlock.svelte) → `markdown.ts`.

**P1 — the agent feels alive and legible**

6. Shimmer on the active status/trace line (token in `style.css`) —
   [`src/app.css:203`](../../open-webui/src/app.css).
7. Elapsed-time label on a collapsed thinking trace ("Thought for 6 s").
8. Status **timeline** from `operation`/`runningTools` —
   [`StatusHistory.svelte`](../../open-webui/src/lib/components/chat/Messages/ResponseMessage/StatusHistory.svelte) → `transcript.ts`.
9. Tool result clamping with "Show all (N chars)" —
   [`ToolCallDisplay.svelte:44`](../../open-webui/src/lib/components/common/ToolCallDisplay.svelte).
10. Empty-session **suggestions** as buttons (from the agent's skills), with
    the waterfall entrance — [`Suggestions.svelte`](../../open-webui/src/lib/components/chat/Suggestions.svelte) → `onboarding`/`transcript`.

**P2 — polish**

11. Jump-to-latest **unseen count** + hidden `role="status"` live region (MUI) → `scroll.ts`.
12. Edge-swipe **gesture policy** on the drawer — [`MobileSwipePanel.svelte:4`](../../open-webui/src/lib/components/common/MobileSwipePanel.svelte) → `panel.ts`.
13. Global shortcut layer (~6 actions) — [`routes/(app)/+layout.svelte`](<../../open-webui/src/routes/(app)/+layout.svelte>).
14. Task list when the agent runs a todo tool — [`TaskList.svelte`](../../open-webui/src/lib/components/chat/Messages/ResponseMessage/TaskList.svelte).
15. After-answer follow-ups as buttons — [`FollowUps.svelte`](../../open-webui/src/lib/components/chat/Messages/ResponseMessage/FollowUps.svelte).
16. Web-search results as a source list (favicon + title) — [`WebSearchResults.svelte`](../../open-webui/src/lib/components/chat/Messages/ResponseMessage/WebSearchResults.svelte) → `tools.ts`.

**Not now:** rich-text input, drag-and-drop upload, voice, model/tool
pickers, runnable code, artifacts editor, configurable keybindings.

---

## 14. One paragraph to keep

Open WebUI's value is not its architecture — it is the accumulated detail of
making a slow, tool-using assistant feel present and controllable: a semantic
log with a fixed measure, rAF-throttled streaming, a scroll that yields to the
reader, a tool row that says exactly what it is doing and lets you approve it
in place, reasoning that collapses, code you can copy, and status that moves
while it works. pi-bots already solved the two hardest structural problems
better (append-only transcript, `pinned` following). What remains is to make
the agent *legible while it runs* and *controllable at the point of state* —
which is squarely the P0/P1 list above, and none of it requires a framework.
