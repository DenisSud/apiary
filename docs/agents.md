# Agents

What a pi-bots agent ("bot") is, what the agent and the service each own, and
how edits become running behavior. Per-component interfaces live in the
package READMEs; the deep bot-facing pi docs live in the fork
(`packages/coding-agent/docs/` in the pi checkout).

## What a bot is

A complete pi agent dir under `$PI_BOTS_HOME` (`~/Bots`), its own git repo.
The agent dir is the cwd of its server; pi reads it as the agent dir —
`skills/`, `extensions/`, `settings.json`, sessions are all local. Shared
plumbing (`auth.json`, `models.json`, `models-store.json`, `trust.json`) is
symlinked from the shared agent dir, so credentials and model catalogs are
machine-wide.

## Identity and behavior

| file | rendered as | owner |
|---|---|---|
| `SOUL.md` | system prompt preamble (`customPrompt`) | agent + user |
| `BEHAVIOR.md` | `<behavior>` section: working rules | agent + user |
| machine facts | `<system_info>` section (`sysinfo`) | service |

Both files are plain Markdown; HTML comments are stripped and each is capped
at 6000 chars. SOUL is who the agent is; BEHAVIOR is how it works. There is
no managed block, and no `SYSTEM.md` / `APPEND_SYSTEM.md`.

## Memory

- **Identity** (above) is always in the prompt.
- **Curated notes** (`base/extensions/memory/`): agent-private and shared
  notes, Markdown with frontmatter, generated indexes, search/read/write
  tools. Deliberate, versioned.
- **Automatic memory** (`base/extensions/mem0/`): recall per input, buffered
  and filtered capture. Retrieval, not files.

## Ownership

| the agent owns | the service owns (admin layer) |
|---|---|
| `SOUL.md`, `BEHAVIOR.md` | the model (`defaultProvider` / `defaultModel`; picker clamped) |
| `settings.json` except admin keys | mandatory packages (union) |
| skills, extensions, own packages, thinking | tool floor (`read`, `write`, `edit`, `bash`) |
| notes and memory writes | shared files, provider auth, updates |

The admin file is `<bot>/.admin-settings.json`, materialized by the
reconciler and merged by the server after global and project settings.
`PI_BOT_MODEL` and `PI_BOT_PACKAGES` are the deployment knobs.

## Commit is apply

Every bot repo has a post-commit hook:

- during setup, only a commit titled exactly `init` applies;
- afterwards, a commit touching `SOUL.md`, `BEHAVIOR.md`, `settings.json`,
  `skills/` or `extensions/` applies; notes-only commits never do.

Apply = stop the server, reconcile the service invariants, start fresh on the
next attach. The web client applies a pending marker itself once a turn
settles; a stopped bot is reconciled on next attach. Rollback is `git revert`,
in the UI or by the agent.

## Registry

`registry/` (or `$PI_REGISTRY_DIR`) holds curated packages an agent may
declare in `settings.json`; declaring is installing. See
`registry/README.md`.

## Extensions

The runtime supports a subset of the pi extension API (tools, context
transforms, tool hooks — no terminal UI, no in-session reload). The fork's
bot docs are the reference; agents should not fight the service-managed
surfaces above.
