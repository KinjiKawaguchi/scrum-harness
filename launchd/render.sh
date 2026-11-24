#!/bin/sh
# Replace {{HOME}}, {{SCRUM_DIR}}, and {{PATH}} in scrum-alerts.plist with this Mac's values and print the result to standard output.
# Usage: bash launchd/render.sh > ~/Library/LaunchAgents/local.scrum-harness.alerts.plist
# launchd does not inherit the login shell's PATH. Read the locations of node and gh from the current shell and put them in PATH.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
scrum_dir=$(cd "$here/.." && pwd)
node_path=$(command -v node) || { echo "node not found" >&2; exit 1; }
gh_path=$(command -v gh) || { echo "gh not found" >&2; exit 1; }
node_dir=$(dirname "$node_path")
gh_dir=$(dirname "$gh_path")
path_value="$node_dir"
[ "$gh_dir" = "$node_dir" ] || path_value="$path_value:$gh_dir"
path_value="$path_value:/usr/bin:/bin"
# Before installing it, check that node and gh are found with the PATH to be installed alone (like launchd, it inherits no environment variables)
env -i PATH="$path_value" /bin/sh -c 'command -v node >/dev/null && command -v gh >/dev/null' || { echo "node and gh are not found in the PATH to install ($path_value)" >&2; exit 1; }
sed -e "s|{{HOME}}|$HOME|g" -e "s|{{SCRUM_DIR}}|$scrum_dir|g" -e "s|{{PATH}}|$path_value|g" "$here/scrum-alerts.plist"
