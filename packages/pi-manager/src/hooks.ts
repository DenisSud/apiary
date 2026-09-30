import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The post-commit hook is the commit→apply trigger. It runs in every bot repo
// after a successful commit and drops an apply marker the connector watches:
//   - while .setup exists, only the agent's final `init` commit applies (and
//     clears the marker);
//   - afterwards, commits touching the config surface apply;
//   - notes-only commits never apply.
// The reconciler reinstalls it, so edits to the file are overwritten.

const POST_COMMIT = `#!/bin/sh
# pi-bots post-commit: mark config-surface commits for the service to apply.
# Installed by pi-manager; the reconciler overwrites edits.
set -u

toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$toplevel" || exit 0

subject=$(git log -1 --pretty=%s 2>/dev/null) || exit 0

if [ -f .setup ]; then
  # Setup is in progress: only the agent's final "init" commit applies.
  [ "$subject" = "init" ] || exit 0
  rm -f .setup
  printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git rev-parse --short HEAD)" > .apply
  exit 0
fi

changed=$(git show --name-only --pretty=format: HEAD 2>/dev/null) || exit 0
case "$changed" in
  *SOUL.md*|*BEHAVIOR.md*|*settings.json*|*skills/*|*extensions/*)
    printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git rev-parse --short HEAD)" > .apply
    ;;
esac
exit 0
`;

export function postCommitHookPath(dir: string): string {
  return join(dir, ".git", "hooks", "post-commit");
}

export function installPostCommitHook(dir: string): void {
  const path = postCommitHookPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // no hook yet
  }
  if (current !== POST_COMMIT) writeFileSync(path, POST_COMMIT);
  chmodSync(path, 0o755);
}
