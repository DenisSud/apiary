# registry — the package registry

Packages an agent can install for itself: extensions and skills that are not
part of the base but are curated enough to share. Each direct subdirectory is
a pi package; declaring its path in the bot's `settings.json` `packages` list
is the install — the service installs the union on reload.

## Packages

| package | kind | what it does |
|---|---|---|
| `web-search` | extension | `web_search` / `web_fetch` via a local SearXNG + trafilatura/pdftotext |
| `systemone` | extension | decision-model middleware: pre-tool risk guard through a local System One endpoint (Kev) |
| `grilling` | skill | stress-test a plan, one question at a time |
| `self-improvement` | skill | turn repeated work into a task, skill or automation |
| `handoff` | skill | write a context handoff between sessions |

## How agents use it

The service sets `PI_REGISTRY_DIR` for every bot; the stable path to a package
is `$PI_REGISTRY_DIR/<name>`. To add one, the agent (or the user) edits the
bot's `settings.json`:

```json
{
  "packages": ["<base package path>", "/abs/path/from/$PI_REGISTRY_DIR/web-search"]
}
```

and commits. The post-commit apply restarts the server and the reconciler
installs the declared union. `PI_REGISTRY_DIR` exists because the literal path
differs between deployments (a checkout here, a read-only mount in the
container); nothing should hard-code it.

The `self-config` skill in the base package is the standing procedure for
this: discuss the change, edit, commit, roll back via git.

## Model

- **Source of truth:** entries in this directory, git-versioned like
  everything else. A SQLite index is a later, derived nicety — search, tags,
  provenance.
- **Entries are real packages:** a `package.json` with a `pi` manifest, so
  they load the same way as any local pi package.
- **Promotion is a copy, never a move.** A bot keeps its copy; the registry
  entry is an independent snapshot that later evolves on its own.
- **Provenance:** entries may record where they came from (`source: bot/<name>`,
  later `git:<url>`), so a bad entry can be traced.
- **Agent-usable, service-enforced:** agents may read and declare registry
  packages; the service owns what the registry contains. A deployment can
  mount it read-only.
