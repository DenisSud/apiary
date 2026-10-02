#!/usr/bin/env bash
# Test runner for the systemone extension (decision-model middleware: tool guard).
#
#   ./test/run.sh harness   — handler tests against a mock System One server, no network
#   ./test/run.sh live      — classify two sample commands against a real endpoint
#                             (from ~/.pi/agent/decision.json; nothing is executed)
#   ./test/run.sh           — both
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$EXT_DIR/test/harness.mjs"

case "${1:-all}" in
  harness) node "$HARNESS" ;;
  live) PI_SYSTEMONE_LIVE=1 node "$HARNESS" ;;
  all) node "$HARNESS"; PI_SYSTEMONE_LIVE=1 node "$HARNESS" ;;
  *) echo "usage: $0 [harness|live|all]" >&2; exit 2 ;;
esac
