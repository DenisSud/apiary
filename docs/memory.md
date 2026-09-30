# Memory

How an agent remembers: two identity files rendered into the prompt, notes
with generated indexes, and the shared user profile. The implementation is
`base/extensions/memory/`; its `SPEC.md` is the historical design record.

## Prompt sections

| source | section | notes |
|---|---|---|
| `<agent dir>/SOUL.md` | preamble (`customPrompt`) | HTML comments stripped; capped at 6000 chars |
| `<agent dir>/BEHAVIOR.md` | `<behavior>` | same cap and stripping |
| policy text + `USER.md` | `<memory>` | `USER.md` only when the shared root is enabled |
| machine facts | `<system_info>` | from the `sysinfo` extension |

SOUL.md is who the agent is; BEHAVIOR.md is how it works. Both are plain files
the agent and the user edit together — there is no managed block. Commits
touching either re-apply through the commit→apply pipeline.

## Notes

- **Agent notes** — `<bot>/notes/`; versioned with the bot repo. The base
  agent (no `PI_CODING_AGENT_DIR`) uses the shared repo root as its single
  note set.
- **Shared notes** — `~/.pi/agent/memory` (`PI_MEMORY_DIR` overrides), one
  machine-wide clone; `USER.md` there is the shared profile of the user.
  `memoryGlobal: false` in `settings.json` disables the shared root for that
  agent (the tools refuse it too).
- A note is Markdown with frontmatter: `title`, `description`, `tags`,
  `created`, `updated`. Title + description are the retrieval surface; the
  body is read only when a note matches.
- `index.md` in each note set is generated from frontmatter. Never edit it by
  hand; notes without frontmatter fall back to the H1 and first paragraph.

## Tools

- `memory_search` — every query word must match somewhere, fuzzy and in any
  order; ranked by match quality (title, description, tags and path above a
  body-only match).
- `memory_read` — load one note by root and path.
- `memory_write` — create or update a note. Writes default to the agent
  scope; `scope: "global"` is for a fact another agent will need (announce it
  in chat).

Every write commits the note and its index, path-scoped, attributed to the
agent, with a timestamp. Agents do not run git in the memory dirs themselves.
A replaced note is marked `status: superseded` with a link instead of being
deleted.

## Policy the agent sees

The `<memory>` section tells the agent, in short: search before researching;
keep durable findings, decisions and state as notes (never transcripts);
update the existing note when the topic exists; default to the agent scope;
commit is handled for you.

## Layouts

A bot:

```text
<bot>/
├── SOUL.md              identity → preamble
├── BEHAVIOR.md          rules → <behavior>
├── notes/               agent notes + generated index.md
└── (shared) ~/.pi/agent/memory/   USER.md + shared notes + index.md
```

The base agent (no agent dir): one set — the shared repo is both the agent
root and the note folder, registered as the `agent` scope.
