#!/bin/sh
# A walk through the harness on a machine that is not this Mac, in a throwaway state directory: init, refresh, the hooks (shell patterns, SCRUM_NAME),
# runtime and the runtime server (`nc -U`), watch, member start and stop in tmux. It talks to no node and no team: the state directory, the tmux session,
# and the socket are made here and removed at the end.
#
#   scripts/linux-smoke.sh [--board <PVT_...> --status-field <PVTSSF_...> --repo <owner/name>]   (the board flags make `refresh` read a real board)
#
# Without the board flags the steps that need GitHub are skipped. Exits 1 if a step fails.
set -u
DIR=$(cd "$(dirname "$0")/.." && pwd)
CLI="$DIR/src/cli.ts"
BIN="$DIR/bin/scrum"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/scrum-smoke-XXXXXX")
export SCRUM_STATE_DIR="$WORK/state"
export SCRUM_RUNTIME_SOCKET="$WORK/runtime.sock"
SESSION="scrum-smoke-$$"
failed=0
board=""
field=""
repo=""
while [ $# -gt 0 ]; do
  case $1 in
    --board) board=$2; shift 2 ;;
    --status-field) field=$2; shift 2 ;;
    --repo) repo=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$1"; }
ok() { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; failed=1; }
check() { # check <description> <command...>
  desc=$1; shift
  if "$@" >"$WORK/out.txt" 2>&1; then ok "$desc"; else bad "$desc"; sed 's/^/      /' "$WORK/out.txt" | head -12; fi
}

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null
  node --no-warnings "$CLI" runtime-stop >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

step "tools"
for tool in node tmux nc git sed grep find date mktemp; do
  if command -v "$tool" >/dev/null 2>&1; then ok "$tool"; else bad "$tool is not installed"; fi
done
nc -h 2>&1 | grep -q 'U' && ok "nc takes -U (a Unix socket)" || bad "nc has no -U"

step "init"
mkdir -p "$WORK/lead" "$WORK/swe1"
check "scrum init writes a configuration" node --no-warnings "$CLI" init --state-dir "$SCRUM_STATE_DIR" \
  --project-id "${board:-PVT_xxxxxxxxxxxxxxxxxxxx}" --status-field-id "${field:-PVTSSF_xxxxxxxxxxxxxxxxxxxx}" --repos "${repo:-acme/app}" --owner-user @owner \
  --techlead TechLead --members SWE1,SWE2
test -f "$SCRUM_STATE_DIR/config.json" && ok "config.json exists" || bad "config.json is missing"

step "the hooks, with SCRUM_NAME (no node for a member's tool call)"
check "a hook of the TechLead runs and writes shell-patterns" sh -c "printf '%s' '{\"session_id\":\"s-lead\"}' | SCRUM_NAME=TechLead '$BIN' hook SessionStart"
sleep 1
sed -n '5,6p' "$SCRUM_STATE_DIR/cache/shell-patterns" 2>/dev/null | tr '\n' ' ' | grep -q 'TechLead SWE1|SWE2' && ok "shell-patterns has the names" || bad "shell-patterns lacks the names: $(cat "$SCRUM_STATE_DIR/cache/shell-patterns" 2>&1 | tr '\n' ' ')"
start=$(date +%s)
printf '%s' '{"session_id":"s-1","tool_name":"Read","tool_input":{},"tool_response":{}}' | SCRUM_NAME=SWE1 "$BIN" hook PostToolUse
elapsed=$(( $(date +%s) - start ))
[ "$elapsed" -le 2 ] && ok "a member's tool call returns in ${elapsed}s" || bad "a member's tool call took ${elapsed}s"
printf '%s' '{"session_id":"s-1"}' | SCRUM_NAME=SWE1 "$BIN" hook UserPromptSubmit
sleep 2
ls "$SCRUM_STATE_DIR/team/" 2>/dev/null | grep -q 's-1.json' && ok "a member's turn boundary writes its heartbeat" || bad "no heartbeat for the member"
ls "$SCRUM_STATE_DIR/log/" 2>/dev/null | grep -q 'member-states.jsonl' && ok "the state log is written" || bad "no state log"
check "the activity line is written in the shell (date -v / date -d)" test -f "$SCRUM_STATE_DIR/cache/activity-due"

step "runtime and the runtime server"
req='{"runtime":"agency-runtime/1","org":"acme","team":"app","op":"describe"}'
out=$(printf '%s' "$req" | "$BIN" runtime)
echo "$out" | grep -q 'participantMetrics' && ok "describe lists the ops (answered by itself)" || bad "describe: $out"
i=0
while [ ! -S "$SCRUM_RUNTIME_SOCKET" ] && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
[ -S "$SCRUM_RUNTIME_SOCKET" ] && ok "the server started and listens" || bad "no server socket"
out=$(printf '%s' "$req" | "$BIN" runtime)
echo "$out" | grep -q '"result"' && ok "describe answered through the server" || bad "through the server: $out"
count=$(pgrep -f "$CLI runtime-serve" | wc -l | tr -d ' ')
[ "$count" = 1 ] && ok "one server" || bad "$count servers"
node --no-warnings "$CLI" runtime-stop >/dev/null 2>&1
sleep 1
[ ! -S "$SCRUM_RUNTIME_SOCKET" ] && ok "runtime-stop removed the socket" || bad "the socket is still there"

step "refresh and lint"
if [ -n "$board" ]; then
  check "scrum refresh reads the board" node --no-warnings "$CLI" refresh
  check "scrum lint runs" node --no-warnings "$CLI" lint
else
  echo "skipped (no --board)"
fi
check "scrum team runs" node --no-warnings "$CLI" team

step "watch"
# the watch waits for a finding for up to 50 minutes, so it is given 10 seconds and is expected to be still waiting (exit 124 of timeout) or to have ended cleanly
if command -v timeout >/dev/null 2>&1; then
  printf '%s' '{"session_id":"s-lead"}' | SCRUM_NAME=TechLead timeout 10 node --no-warnings "$CLI" watch >"$WORK/out.txt" 2>&1
  rc=$?
  if [ "$rc" = 124 ] || [ "$rc" = 0 ] || [ "$rc" = 2 ]; then ok "scrum watch runs (exit $rc)"; else bad "scrum watch exited $rc"; sed 's/^/      /' "$WORK/out.txt" | head -8; fi
else
  echo "skipped (no timeout command)"
fi

step "member start and stop (tmux)"
node --no-warnings - "$SCRUM_STATE_DIR/config.json" "$WORK/swe1" "$SESSION" <<'JS'
const { readFileSync, writeFileSync } = await import('node:fs')
const [path, dir, session] = process.argv.slice(2)
const config = JSON.parse(readFileSync(path, 'utf8'))
config.launch = { tmuxSession: session, members: { SWE1: { dir } } }
writeFileSync(path, JSON.stringify(config, null, 2))
JS
check "member start --dry-run prints the command" node --no-warnings "$CLI" member start SWE1 --dry-run
check "member list runs" node --no-warnings "$CLI" member list

if [ -z "${SCRUM_SMOKE_REAL_MEMBER:-}" ]; then
  echo "skipped starting a real Claude Code session (set SCRUM_SMOKE_REAL_MEMBER=1 to start one in the throwaway tmux session)"
else
  check "member start opens a tmux window" node --no-warnings "$CLI" member start SWE1 --no-wait
  sleep 3
  tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -q SWE1 && ok "the window SWE1 exists" || bad "no window SWE1"
  tmux capture-pane -p -t "$SESSION:SWE1" 2>/dev/null | tail -12 | sed 's/^/      screen: /'
  check "member stop --force closes it" node --no-warnings "$CLI" member stop SWE1 --force
fi

printf '\n'
if [ "$failed" = 0 ]; then echo "all steps passed"; else echo "some steps FAILED"; fi
exit "$failed"
