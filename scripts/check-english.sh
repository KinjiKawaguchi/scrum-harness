#!/usr/bin/env bash
# Fails when a tracked file contains Japanese text (hiragana, katakana, or Han characters).
# English is the only language of this repository (see CLAUDE.md). A file that has to hold such text,
# such as a test of Japanese input, is listed in scripts/english-allowlist.txt (one path per line;
# blank lines and lines starting with # are ignored). Prefer a \u escape in the test over an entry.
#
#   scripts/check-english.sh [<repository>]   defaults to the repository this script is in
set -euo pipefail

root=${1:-$(cd "$(dirname "$0")/.." && pwd)}
allowlist="$root/scripts/english-allowlist.txt"
export LC_ALL=C.UTF-8

excludes=()
if [ -f "$allowlist" ]; then
  while IFS= read -r line; do
    case "$line" in '' | '#'*) continue ;; esac
    excludes+=(":(exclude)$line")
  done <"$allowlist"
fi

if found=$(git -C "$root" grep -nP '[\p{Hiragana}\p{Katakana}\p{Han}]' -- . "${excludes[@]}"); then
  printf '%s\n' "$found"
  echo "Japanese text found above. Write it in English, or use a \\u escape in a test (allow list: scripts/english-allowlist.txt)." >&2
  exit 1
fi
