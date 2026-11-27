#!/bin/bash
# A stand-in for `claude` in a member's tmux window: it shows the question Claude Code asks about trusting a folder (with "No, exit" focused), takes Down and
# Enter, then reports a session start through the harness's hook (as the real session would), and writes each line typed into it to fake-claude.log in the
# state directory. The hook to call is the path in the state directory's fake-claude-hook, since a window gets only the settings of its launch plan.
# Not a test of Claude Code: a test of what the harness does to a window (the keys it sends, the screen it reads, the sign of life it waits for).
log=${SCRUM_STATE_DIR:-/tmp}/fake-claude.log
hook=$(cat "${SCRUM_STATE_DIR:-/nonexistent}/fake-claude-hook" 2>/dev/null)
focus=no
draw() {
  clear
  printf ' Accessing workspace:\n\n %s\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open\n source project, or work from your team). If not, take a moment to review what'"'"'s in this folder first.\n\n Claude Code'"'"'ll be able to read, edit, and execute files here.\n\n Security guide\n\n' "$PWD"
  if [ "$focus" = no ]; then printf ' \xe2\x9d\xaf No, exit\n   Yes, I trust this folder\n'; else printf '   No, exit\n \xe2\x9d\xaf Yes, I trust this folder\n'; fi
  printf '\n Enter to confirm \xc2\xb7 Esc to cancel\n'
}
draw
if [ ! -f "${SCRUM_STATE_DIR:-/nonexistent}/fake-claude-no-trust" ]; then
  while IFS= read -rsn1 key; do
    if [ "$key" = $'\e' ]; then
      IFS= read -rsn2 rest
      [ "$rest" = '[B' ] || [ "$rest" = 'OB' ] && { focus=yes; draw; }
    elif [ -z "$key" ] && [ "$focus" = yes ]; then
      break
    fi
  done
fi
clear
printf 'Welcome to the fake Claude Code\n\n> '
if [ -n "$hook" ]; then
  printf '{"session_id":"fake-%s"}' "$$" | "$hook" hook SessionStart >/dev/null 2>&1
fi
while IFS= read -r line; do
  printf '%s\n' "$line" >>"$log"
  case $line in
    /exit)
      if [ -n "$hook" ]; then printf '{"session_id":"fake-%s"}' "$$" | "$hook" hook SessionEnd >/dev/null 2>&1; fi
      exit 0
      ;;
  esac
  printf '> '
done
