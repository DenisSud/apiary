#!/usr/bin/env bash
# Run the apiary service container locally.
#
# State (agents, server state, credentials) lives in the apiary-data volume.
# The container filesystem is read-only; only the volume and /tmp are
# writable. The port is published on loopback only: there is no auth in front
# of the bridge yet (issue #18).
#
#   deploy/run.sh [image-tag]          default: apiary:local
set -euo pipefail

image="${1:-apiary:local}"
port="${APIARY_PORT:-8787}"
# Conservative defaults; the hosted control plane (#24) will own per-user limits.
memory="${APIARY_MEMORY:-4g}"
cpus="${APIARY_CPUS:-4}"
pids="${APIARY_PIDS:-512}"

# Semantic memory (optional): forward the deployment's mem0 settings to the
# bots. The values are injected at run time; nothing is baked into the image.
mem0_env=()
for name in MEM0_BASE_URL MEM0_API_KEY MEM0_GATE_BASE_URL MEM0_GATE_MODEL MEM0_FILTER_BASE_URL MEM0_FILTER_MODEL; do
  if [ -n "${!name:-}" ]; then mem0_env+=(-e "$name"); fi
done

exec docker run --rm -it \
  --name apiary \
  --read-only --tmpfs /tmp \
  --init \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory "$memory" --cpus "$cpus" --pids-limit "$pids" \
  -p "127.0.0.1:${port}:8787" \
  -v apiary-data:/data \
  "${mem0_env[@]}" \
  "$image"
