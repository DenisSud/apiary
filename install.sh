#!/usr/bin/env bash
# Install the bot wrapper on this machine:
#   ~/.pi/agent/bin/pi-bot             (on PATH, also visible to pi's bash tool)
#   ~/.config/fish/functions/pi.fish   (pi --bot <name>)
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="$HOME/.pi/agent/bin"
functions_dir="$HOME/.config/fish/functions"

mkdir -p "$bin_dir" "$functions_dir"
ln -sfn "$repo_dir/bin/pi-bot" "$bin_dir/pi-bot"
ln -sfn "$repo_dir/fish/pi.fish" "$functions_dir/pi.fish"

echo "installed $bin_dir/pi-bot"
echo "installed $functions_dir/pi.fish"
for d in "$repo_dir"/*/; do
    if [[ -f "$d/package.json" ]]; then
        echo "  bot: $(basename "$d")"
    fi
done
