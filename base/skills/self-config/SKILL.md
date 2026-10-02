---
name: self-config
description: Configure this agent — interview the user during first setup, and later discuss, apply and roll back changes to who you are (SOUL.md), how you work (BEHAVIOR.md), settings, skills, extensions and packages. Use when the user asks to change your identity, behavior, capabilities or configuration.
---

# Self-config

You are the only one who edits this agent. The user owns the decisions; you own
the files. **Commit is apply**: a commit touching a config surface makes the
service stop, reconcile and restart you from it. Notes-only commits never
restart anything.

**During setup** (a `.setup` marker exists in the agent dir) only a commit
titled exactly `init` applies, and it ends setup.

## What is yours, what is the service's

| yours | the service's |
|---|---|
| `SOUL.md`, `BEHAVIOR.md`, `settings.json` (except shadowed keys), `skills/`, `extensions/`, notes, added packages | the model, credentials, mandatory packages, the tool floor (`read`, `write`, `edit`, `bash`), the shared `auth.json` / `models.json` / `trust.json` symlinks |

The service regenerates its layer on every start — editing those values is
wasted work, and the model picker is clamped. Never run `pi update` or
`pi remove` on managed entries.

## First setup

Kickoff is the service's first-setup message — "Set me up", sent through
this skill. Begin with the first question immediately: don't summarize your
environment or explain the process; a fresh agent dir has nothing worth
reporting.

1. **Interview**, one question at a time, at most five questions, each with
   your recommended answer. Look facts up (files, environment) instead of
   asking. Cover, in order: what the user works on; how you should sound; what
   you must never do; recurring work worth a skill; anything to connect or
   install.
   Done when every answer is in and the user confirms nothing is missing.
2. **Write it down**, keeping each file short — they enter context every turn:
   - `SOUL.md` — identity, voice, values, boundaries.
   - `BEHAVIOR.md` — how you work: small steps, ask before destructive
     actions, note habits.
   - `settings.json` — only what is truly needed (for example a thinking
     level).
   - `skills/` — one skill per recurring procedure worth automating.
   Done when every interview answer has a home or was explicitly dropped.
3. **Commit once** with the subject `init`.
   Done when the commit lands; the service applies it and setup is over.

## Changing things later

1. **Question first.** If the change is not concrete, interview one question
   at a time until it is: what should feel different, and when. Facts you can
   look up, you look up.
   Done when you can state the change in one sentence.
2. **Pick the surface** (table below) and edit the files.
3. **Commit** with a clear subject (`config: …`) — that applies it.
4. **Verify** after the restart. If the change is wrong, roll back with git
   (`git revert <sha>`, or restore the file) and commit the rollback.

## Surfaces

| The user wants… | Edit | Notes |
|---|---|---|
| a different personality, voice, values | `SOUL.md` | the system prompt preamble |
| different working habits | `BEHAVIOR.md` | always-on behavior rules |
| thinking level, compaction, other preferences | `settings.json` | admin-shadowed keys do not take effect |
| a reusable procedure | `skills/<name>/SKILL.md` | auto-discovered; commit applies |
| a new tool | `extensions/<name>/index.ts` | use the supported extension API subset (pi docs) |
| a shared package | `settings.json` `packages` + `$PI_REGISTRY_DIR/<name>` | list: `$PI_REGISTRY_DIR/README.md` |
| durable knowledge | `memory_write` | notes, not config |

Declaring an npm/git package in `settings.json` is enough — the reconciler
installs the union on the next apply.

## Style

- One question at a time, recommended answer attached.
- Edit the file that already owns the meaning; never duplicate it into both
  SOUL and BEHAVIOR.
- Keep it small. A shorter SOUL that is true beats a long one that flatters.
- Say what you changed and where, then stop.
