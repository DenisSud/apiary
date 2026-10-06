#!/usr/bin/env bash
# Fetch the mem0 fork into mem0-src/, the library the server image installs.
#
# The fork (DenisSud/mem0, see PI-FORK.md there) carries the System One gates;
# PyPI's mem0ai does not have them. Run this before `podman-compose build`.
#
#   printf '%s\n' "$FORGEJO_TOKEN" | ./fetch-fork.sh
#
# Env: MEM0_FORK_URL (default the Forgejo API for DenisSud/mem0),
#      MEM0_FORK_REF (default the tag pinned below), MEM0_FORK_TOKEN
#      (else read from stdin). Pin the ref: it decides which gates ship.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${MEM0_FORK_URL:-https://git.sudakov.site/api/v1/repos/DenisSud/mem0}"
ref="${MEM0_FORK_REF:-pi-2.2.1}"

token="${MEM0_FORK_TOKEN:-}"
if [[ -z "$token" ]]; then
  read -r token
fi
if [[ -z "$token" ]]; then
  echo "fetch-fork: no token (pass it on stdin or in MEM0_FORK_TOKEN)" >&2
  exit 1
fi

# Only what a `pip install` of the package needs; keep this list tied to the
# fork's pyproject (hatch builds mem0/** from these files).
contents=(mem0 pyproject.toml README.md LICENSE)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -H "Authorization: token $token" "$repo/archive/$ref.tar.gz" -o "$tmp/fork.tar.gz"
mkdir -p "$tmp/src"
tar -xzf "$tmp/fork.tar.gz" -C "$tmp/src" --strip-components=1

for entry in "${contents[@]}"; do
  if [[ ! -e "$tmp/src/$entry" ]]; then
    echo "fetch-fork: $ref has no $entry — wrong ref?" >&2
    exit 1
  fi
done

rm -rf "$here/mem0-src"
mkdir -p "$here/mem0-src"
for entry in "${contents[@]}"; do
  cp -R "$tmp/src/$entry" "$here/mem0-src/"
done

version="$(grep -m1 '^version' "$here/mem0-src/pyproject.toml" | cut -d'"' -f2)"
echo "fetch-fork: $ref → mem0-src (mem0ai $version)"
