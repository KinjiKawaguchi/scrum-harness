#!/usr/bin/env bash
# Keeps this repository in step with Agency's TeamView contract (agency-runtime/1).
#
#   scripts/agency-contract.sh check    fail when Agency's main differs from contract/agency.lock
#   scripts/agency-contract.sh update   copy Agency's bindings and shared sample, and rewrite contract/agency.lock
#
# Agency's generated TypeScript types (bindings/*.ts) are copied unchanged to src/agency-runtime/bindings/, and
# the shared sample (testdata/teamview.sample.json) to test/fixtures/agency/teamview.sample.json. The lock records
# the Agency commit and the hash of each. A test checks the copies against the lock without the network; `check`
# compares Agency's main against the lock. After an update, fix whatever no longer type-checks.
#
# Agency's sources come from the sibling repository named `agency` under the same owner as this one, through `gh`.
# AGENCY_CHECKOUT=<path> reads a local clone's origin/main instead.
set -euo pipefail

mode=${1:-check}
root=$(cd "$(dirname "$0")/.." && pwd)
lock="$root/contract/agency.lock"
fixture="$root/test/fixtures/agency/teamview.sample.json"
bindings_dir="$root/src/agency-runtime/bindings"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
src="$work/agency"
mkdir -p "$src"

if [ -n "${AGENCY_CHECKOUT:-}" ]; then
  git -C "$AGENCY_CHECKOUT" archive origin/main bindings testdata/teamview.sample.json | tar -x -C "$src"
  commit=$(git -C "$AGENCY_CHECKOUT" rev-parse origin/main)
else
  owner=$(gh repo view --json owner --jq .owner.login)
  commit=$(gh api "repos/$owner/agency/commits/main" --jq .sha)
  gh api "repos/$owner/agency/tarball/$commit" > "$work/agency.tar.gz"
  tar -xzf "$work/agency.tar.gz" -C "$src" --strip-components=1 --include='*/bindings/*' --include='*/testdata/teamview.sample.json'
fi

hash() { shasum -a 256 | cut -d' ' -f1; }
bindings=$(cd "$src/bindings" && for f in $(LC_ALL=C ls *.ts); do printf '%s\n' "$f"; cat "$f"; done | hash)
sample=$(hash < "$src/testdata/teamview.sample.json")
current=$(printf 'commit=%s\nbindings=%s\nfixture=%s\n' "$commit" "$bindings" "$sample")

case "$mode" in
  update)
    cp "$src/testdata/teamview.sample.json" "$fixture"
    rm -rf "$bindings_dir" && mkdir -p "$bindings_dir" && cp "$src"/bindings/*.ts "$bindings_dir/"
    printf '%s\n' "$current" > "$lock"
    echo "updated contract/agency.lock to ${commit:0:12}"
    ;;
  check)
    locked_bindings=$(sed -n 's/^bindings=//p' "$lock")
    locked_fixture=$(sed -n 's/^fixture=//p' "$lock")
    status=0
    [ "$bindings" = "$locked_bindings" ] || { echo "Agency's bindings changed since $(sed -n 's/^commit=//p' "$lock" | cut -c1-12): run scripts/agency-contract.sh update, then fix what no longer type-checks" >&2; status=1; }
    [ "$sample" = "$locked_fixture" ] || { echo "Agency's shared sample changed: run scripts/agency-contract.sh update" >&2; status=1; }
    [ $status -ne 0 ] || echo "in step with Agency ${commit:0:12}"
    exit $status
    ;;
  *)
    echo "usage: $0 check|update" >&2
    exit 2
    ;;
esac
