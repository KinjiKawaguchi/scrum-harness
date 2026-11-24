#!/bin/sh
# scrum-alerts.plist の {{HOME}}、{{SCRUM_DIR}}、{{PATH}} を、この Mac の値に置き換えて、標準出力に出す。
# 使い方: bash launchd/render.sh > ~/Library/LaunchAgents/local.scrum-harness.alerts.plist
# launchd はログインシェルの PATH を引き継がない。いまのシェルから node と gh の場所を読み、PATH に入れる。
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
# 置く PATH だけで node と gh が見つかるかを、置く前に見る (launchd と同じく、環境変数を引き継がない)
env -i PATH="$path_value" /bin/sh -c 'command -v node >/dev/null && command -v gh >/dev/null' || { echo "node and gh are not found in the PATH to install ($path_value)" >&2; exit 1; }
sed -e "s|{{HOME}}|$HOME|g" -e "s|{{SCRUM_DIR}}|$scrum_dir|g" -e "s|{{PATH}}|$path_value|g" "$here/scrum-alerts.plist"
