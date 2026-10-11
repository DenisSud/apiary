# Contributing to apiary

apiary runs a fleet of personal AI agents. Contributions are welcome — the
bar is: small, explained, tested.

## How to work

1. Branch off `main` — one feature or fix per branch.
2. Keep PRs small and single-purpose. No unrelated changes smuggled in.
3. Every PR names **where in the repo to look** to understand the piece being
   changed: file paths plus one line on why that is the right place. The
   maintainer reviews without the codebase fully loaded; this is mandatory.
4. Run `devenv shell -- check` before opening a PR — it runs the package
   suites (pi-manager, auth, connector, web) and every extension harness.
   This is the pre-commit gate.
5. `main` is protected by a ruleset: force pushes and deletions are blocked
   for everyone, changes land via PR. The maintainer fast-tracks their own
   PRs; outside contributors get review.

## Commit style

Short imperative subject, lowercase, scope prefix when obvious, no tag
prefixes:

    connector: cap bot name at 32 characters
    web: creation step — face left, name and config right

## PR checklist

- [ ] What & why, one or two sentences
- [ ] Where to look in the repo (paths + why this place)
- [ ] How it was tested (`check` output, manual steps)
- [ ] No unrelated changes

## Bigger changes

Open an issue first (label `proposal`) before large refactors — anything
touching the agent-dir format, the bridge contract, or the `$APIARY_HOME`
layout.
