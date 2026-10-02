# memory — identity and curated notes

The memory extension renders the agent's identity into the prompt and gives
it a curated, git-versioned note system. Automatic semantic memory is a
separate extension (`base/extensions/mem0/`).

## Prompt sections

| source | section | notes |
|---|---|---|
| `SOUL.md` | preamble (`customPrompt`) | HTML comments stripped; capped at 6000 chars |
| `BEHAVIOR.md` | `<behavior>` | same |
| policy text + `USER.md` | `<memory>` | `USER.md` only when the shared root is enabled |
| machine facts | `<system_info>` | from the `sysinfo` extension |

## Notes

- **Agent notes** — `<bot>/notes/`, versioned with the bot repo. The base
  agent (no `PI_CODING_AGENT_DIR`) uses the shared repo root as its set.
- **Shared notes** — `~/.pi/agent/memory` (`PI_MEMORY_DIR` overrides), one
  machine-wide clone; `USER.md` there is the shared user profile.
  `memoryGlobal: false` disables the shared root for an agent.
- A note is Markdown with frontmatter (`title`, `description`, `tags`,
  `created`, `updated`). Title + description are the retrieval surface; the
  body is read only when a note matches.
- `index.md` per set is generated from frontmatter; never edit it by hand.
- Every write commits the note and its index, path-scoped, attributed to the
  agent. A replaced note is marked `status: superseded` with a link, not
  deleted.

## Tools

- `memory_search` — every query word must match somewhere, fuzzy, any order;
  ranked by match quality.
- `memory_read` — load one note by root and path.
- `memory_write` — create or update a note; default scope is the agent;
  `scope: "global"` is for facts another agent needs.

## Tests

`./test/run.sh harness` — no network; requires the installed `pi` store.
