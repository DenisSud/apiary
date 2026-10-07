# registry — the package registry

Where a curated pi package an agent may install for itself would live. The
service exports this directory to every bot as `PI_REGISTRY_DIR`.

**It holds no packages for now.** Nothing agent-side ships in this repo: the
extensions and skills a deployment runs live in that deployment's own pi
package. Add an entry here when the service itself should curate one.

## How agents use it

The stable path to a package is `$PI_REGISTRY_DIR/<name>`. To add one, the
agent (or the user) edits the bot's `settings.json`:

```json
{
  "packages": ["<base package path>", "/abs/path/from/$PI_REGISTRY_DIR/<name>"]
}
```

and commits. The post-commit apply restarts the server and the reconciler
installs the declared union. `PI_REGISTRY_DIR` exists because the literal path
differs between deployments (a checkout here, a read-only mount in the
container); nothing should hard-code it.

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
