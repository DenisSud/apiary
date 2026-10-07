#!/usr/bin/env bash
# Build the pi-bots service image from the local checkouts.
#
# The Docker build context is assembled in a temp dir: the pi-bots working
# tree and the pi checkout (the `pi/` submodule, or $PI_SOURCE_DIR), without
# node_modules or .git; dependencies are installed inside the image.
#
#   deploy/build.sh [image-tag]        default: pi-bots:local
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
pi_dir="${PI_SOURCE_DIR:-$root/pi}"
image="${1:-pi-bots:local}"

for dir in "$root" "$pi_dir"; do
  if [ ! -f "$dir/package.json" ]; then
    echo "build.sh: no package.json in $dir" >&2
    exit 1
  fi
done

# The bot servers run pi from source ($pi_dir). The source runtime imports the
# generated model catalogs under packages/ai/src/providers/data, which are
# gitignored: a fresh checkout has none and every bot server dies at startup
# with ERR_MODULE_NOT_FOUND. Fail here with a clear message instead.
model_data="$pi_dir/packages/ai/src/providers/data"
if [ ! -d "$model_data" ] || [ -z "$(find "$model_data" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "build.sh: $pi_dir has no generated model catalogs (packages/ai/src/providers/data)" >&2
  echo "  generate them once per checkout: (cd $pi_dir/packages/ai && npm run hydrate-model-data)" >&2
  exit 1
fi

ctx="$(mktemp -d)"
trap 'rm -rf "$ctx"' EXIT
mkdir -p "$ctx/pi-bots" "$ctx/pi"
tar -C "$root" --exclude=node_modules --exclude=.git --exclude=./pi --exclude='packages/web/dist' -cf - . | tar -C "$ctx/pi-bots" -xf -
tar -C "$pi_dir" --exclude=node_modules --exclude=.git -cf - . | tar -C "$ctx/pi" -xf -

docker build -t "$image" -f "$root/deploy/Dockerfile" "$ctx"
echo "built $image"
