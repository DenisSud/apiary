#!/usr/bin/env bash
# Build the pi-bots service image from the local checkouts.
#
# The Docker build context is assembled in a temp dir: the pi-bots working
# tree and the pi checkout ($PI_SOURCE_DIR, default ~/dev/pi), without
# node_modules or .git; dependencies are installed inside the image.
#
#   deploy/build.sh [image-tag]        default: pi-bots:local
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
pi_dir="${PI_SOURCE_DIR:-$HOME/dev/pi}"
image="${1:-pi-bots:local}"

for dir in "$root" "$pi_dir"; do
  if [ ! -f "$dir/package.json" ]; then
    echo "build.sh: no package.json in $dir" >&2
    exit 1
  fi
done

ctx="$(mktemp -d)"
trap 'rm -rf "$ctx"' EXIT
mkdir -p "$ctx/pi-bots" "$ctx/pi"
tar -C "$root" --exclude=node_modules --exclude=.git --exclude='packages/web/dist' -cf - . | tar -C "$ctx/pi-bots" -xf -
tar -C "$pi_dir" --exclude=node_modules --exclude=.git -cf - . | tar -C "$ctx/pi" -xf -

docker build -t "$image" -f "$root/deploy/Dockerfile" "$ctx"
echo "built $image"
