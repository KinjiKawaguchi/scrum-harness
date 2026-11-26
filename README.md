# scrum-harness

A harness that lets a TechLead session in Claude Code notice drift on a GitHub Project board, and members that have gone idle, without going to look for them.

Detection is done by deterministic scripts. Claude Code hooks put only the difference into the TechLead's context. The model does the fixing.

## How it works

```
[Collect: no tokens]                              [Judge: pure functions]   [Notify: hooks]
board copy (GraphQL, every 5 minutes + right after a write) ─┐
~/.claude/sessions and member heartbeats ────────────────────┼→ rules (docs/rules.md) → TechLead's context / statusline
intended exceptions (scrum ack) ─────────────────────────────┘
```

| Hook | TechLead | Member | Outside the team |
|---|---|---|---|
| SessionStart (start, resume, after compaction) | Injects a summary of everything. Starts the watch | Heartbeat | Does nothing |
| UserPromptSubmit | Injects new findings | Heartbeat | Does nothing |
| PreToolUse (Bash) | For scripts that change Status (such as `scripts.setStatus`), refuses going over the In Progress limit and setting a Status on a PR | Same | Same |
| PostToolUse | After a command that touches the board: fixes the board copy, and injects findings for the issue touched and a merge note. Otherwise injects new findings only when the watch process has left its marker | Does nothing | Does nothing |
| Stop | Stops once if there is a high finding that has not stopped it before. Starts the watch (asyncRewake) | Heartbeat | Does nothing |
| Notification (permission_prompt) | — | Heartbeat for a permission prompt | Does nothing |

**Activity record (`activity`)**: In any session of the team (TechLead, member, or liaison), the PostToolUse hook appends one `activity` line to `events.jsonl` if the last record is 10 minutes old or more. UserPromptSubmit, SessionStart, and Stop do not append it (during the weekly limit these hooks still run for the input of scheduled runs, but PostToolUse is the result of a tool, so it does not run). It is done in the shell layer of `bin/scrum`, without starting node. Sessions outside the team do not append it. It makes the time when all sessions were stopped readable whether or not `watch` is running (see the sprint section of `docs/rules.md`).

The watch (`scrum watch`) is started with `asyncRewake` from the TechLead's Stop and SessionStart. A member's Stop and SessionStart also start it, but only when `dispatch.enabled` is true in the configuration. If a member stays idle and has no valid acknowledgement, the watch picks the next issue, rewrites the board, and wakes the member's session with a message (A-DISPATCH in docs/rules.md; no LLM involved). The liaison (the session named in `alerts.liaison`) also starts it, but only when `alerts.enabled` is true, and wakes the liaison with the message that the stall detection (E-STALL, Q-EMPTY) has decided (see "Detecting stalls and notifying the owner" in docs/rules.md). Every 30 seconds it looks at the board copy (refetched if older than 5 minutes) and at activity, and wakes the TechLead with exit 2 when a finding of medium or higher severity appears that has not been reported. If the TechLead is working it does not wake it: it leaves a marker (`notify/pending`) and the next tool call injects the finding. It ends after 50 minutes at most, and starts again at the next Stop. When the source is updated it ends at that moment, so that old code does not keep running.

So that a heavily loaded Mac does not start node on every tool call, `bin/scrum` looks at the session's role and routes. Tool calls of sessions outside the team, and of members and the liaison, end in the shell alone (30 to 60 milliseconds).

## Installation

```sh
pnpm install                     # only for type checks and tests; node 24 alone is enough to run it
cp config.example.json ~/.claude/scrum/config.json   # edit it for your board and team
bin/scrum refresh && bin/scrum lint                  # check the findings
bin/scrum install                # adds the hooks to ~/.claude/settings.json (backs it up first)
```

To remove it, `bin/scrum uninstall`. `install` and `uninstall` take `--dir <configuration directory>` for one Claude Code configuration directory (a `settings.json` that is not there yet is created) and `--all` for every directory in `claudeConfigDirs`. A change to settings.json takes effect in running sessions as well.

The main settings in the configuration (`config.json`):

| Setting | Meaning |
|---|---|
| `claudeConfigDirs` | The Claude Code configuration directories (`CLAUDE_CONFIG_DIR`) the team's sessions run under, as absolute paths or `~/...` (optional; default `["~/.claude"]`). The session records and the transcripts of every directory are read, so a member is found, and its usage counted, wherever it runs. Install the hooks in each with `scrum install --all`. A session of another directory also needs `SCRUM_STATE_DIR` in its environment |
| `offBoard` | Which open issues of `repos` that are not on the board count as off the board (B-OFF-BOARD), for a repository shared with other teams (optional). `scope`: `all` (the default: every open issue), `none` (only what is on the board is watched, and the repository's issues are not even listed), or `filter` with `labels` and/or `assignees` (only an open issue with a listed label, or assigned to a listed login). A section of the wrong shape makes the configuration unusable, so it never falls back to flagging every other team's issue |
| `launch` | How the team's members are started and found (optional). `tmuxSession` (the tmux session with one window per member, named after the member), `defaults` and `members` (per member: `dir`, `brief`, `product`, `model`, `effort`, `permissions`; `permissions: "skip"` starts a member without permission prompts and is never a default), `ignoreWindows` (windows that are not members). A key that is not known, or a value of the wrong shape, makes the section ignored. See [Members](#members) |
| `hookTools` | Tools besides Bash whose calls the hooks read (optional): names, or patterns of name characters and `*`, such as `mcp__<server>__.*` for the tools of an MCP server. `scrum install` adds them to the matcher of the write guard (PreToolUse); PostToolUse already sees every tool. What a call means for the board is decided by the action reader of the board adapter (`ActionReader.actionsOf`, which gets the tool name, its input, and after the call its answer); the GitHub reader reads Bash only |
| `adapters` | The board side for a tracker other than GitHub Projects (optional), as a board module kept outside this repository (`module`, an absolute path, and `options`, JSON passed to it) or as a program that speaks `scrum-board/1` (`command`, its `capabilities`, `timeoutSeconds`, and `options`). It provides any of the board, the writer, the action reader, the issue thread, and the code host; the rest stays GitHub. See [docs/board-module.md](docs/board-module.md) |
| `host` | The GitHub host name when the board is on GitHub Enterprise (for example `ghe.example.com`). Every `gh` call and every board script the harness runs gets `GH_HOST=<host>`. Optional; without it `gh`'s own default host applies. See [GitHub Enterprise](#github-enterprise) |
| `projectId`, `repos`, `defaultRepo` | The board and the repositories to check |
| `fields`, `statuses`, `reasonNone`, `reasonJudge`, `statusFieldId` | The names of the board's fields and options. `fields.workType` (optional) names a single-select field that says what kind of work an item is (for example New feature, Improvement, Maintenance, Debt, Incident); when set, the harness reads it into each item |
| `ownerUser`, `ownerLabel` | The Owner value of the person who decides, and the name used for them in messages |
| `techlead`, `members` | The names of the TechLead and member sessions (the names ListAgents shows) |
| `scripts` | The names of the scripts that rewrite the board (optional). Used in the fix text; the hooks read their runs |
| `wipLimit`, `idleMinutes`, and others | The strength of the checks (optional) |
| `links` | Lists open PRs in the body of the issue each one points to, between the markers (`<!-- scrum-harness:prs -->` and `<!-- /scrum-harness:prs -->`) (optional; it runs only when `enabled` is true). `intervalMinutes`, `maxEditsPerRun`, `skipAuthors`, `skipBranchPrefixes`. See "Linking PRs and issues" in docs/rules.md |
| `alerts` | Stall detection and notifying the owner (optional; it runs only when `enabled` is true). `liaison` (the liaison session's name), `epicStallMinutes`, `emptyEscalateMinutes`, `isDesktopEnabled`, `parkedLabels` (labels that mark a parked Epic), `epicPushMinutes` (how often the owner is notified about the same Epic), `emptyPushMinutes` (how often the owner is notified about the same member with nothing to hand over). See "Detecting stalls and notifying the owner" in docs/rules.md |
| `dispatch` | Hands the next work to an idle member (optional; it runs only when `enabled` is true). `baseBranch`, `skipLabels`, `orderField`, `members`, `scriptDir`, `linkedBranchPrefix` (creates a branch linked to the issue when handing over), `notes`. See "Handing the next work to idle members" in docs/rules.md |
| `team` | Several teams on one board (optional). `field` (the board's single-select field that tells teams apart, for example `Team`), `value` (this team's option), `adoptsUnassigned` (the team also owns items with no value and issues not on the board; at most one team on a board). See [Several teams on one board](#several-teams-on-one-board) |
| `runtime` | The team's display name, the time zone of the usage report, and the names of the board's blocked reasons, for `scrum runtime` (optional). See docs/agency-runtime.md |

### Several teams on one board

Each team keeps its own harness (its own state directory and configuration). To share one board, add a single-select field such as `Team` with one option per team, and give each team its section:

```json
"team": { "field": "Team", "value": "node", "adoptsUnassigned": true }
```

The harness reads the whole board and narrows it to the items whose field has the team's value, so every check, the dispatch, the links, and the runtime view see only the team's work. An issue that is on the board under another team is not reported as off the board. Exactly one team sets `adoptsUnassigned`: it also owns the items with no value and the issues that are not on the board, so no two teams fight over one item. Without a `team` section the whole board is the team's. A `team` section of the wrong shape makes the whole configuration unusable (it never falls back to the whole board), and a `value` that is not an option of the field fails the board read with that message.

To move an existing single team: add the field, set it on the existing items (`scrum board move --unassigned --team <name>` does it for every item that has no team), then add the section with `adoptsUnassigned: true`. The behavior is the same at every step. The team that adopts unassigned work gets the finding B-NO-TEAM for an open issue that is on the board with no team (fix: `scrum board move`), and `scrum board add` as the fix for an issue that is not on the board.

### GitHub Enterprise

The harness does not name github.com anywhere; it reaches GitHub through `gh`, which picks its host from `GH_HOST` or its own default. On a machine that is signed in to more than one host, or when a scheduled job runs without your shell's environment, that default may be the wrong one, so set `host` in the configuration:

```json
"host": "ghe.example.com"
```

- `repos` and `defaultRepo` stay `owner/repo`; the host is not part of them.
- Sign `gh` in to the host first: `gh auth login --hostname ghe.example.com`, then `gh auth status --hostname ghe.example.com`. For single sign-on, authorize the token for the organization (the link `gh` prints, or the token's settings); a failure about SAML or SSO is logged in `errors.log` with that hint.
- A scheduled job (launchd or a systemd user timer) needs to reach the token. On macOS the keychain works from a launchd agent. On Linux there may be no keyring in a systemd user session; set `GH_ENTERPRISE_TOKEN` in the unit's environment, or sign in with `gh auth login --insecure-storage`.
- The fix text that runs `gh` itself starts with `GH_HOST=<host>`, and a board command you type with `GH_HOST=...` in front, or with `-R <host>/owner/repo`, is read as usual.
- The dispatch and alerts features read an issue's parent (sub-issues). An older GitHub Enterprise Server may not have that field; if the board read fails with an unknown field, leave `dispatch` and `alerts` disabled there.

### Members

`launch` is the one place that says where each member runs, so the `members` list and what runs do not drift apart. `scrum member list` shows, for the lead, the members, and the liaison, whether each one runs (a window in the tmux session, or a live session record, with its activity), and reports both kinds of drift: windows that are not in the configuration, and listed members that are not running. Without a `launch` section it judges from the session records only. `scrum member start <name...>` (or `--all`, for every member that has launch settings) starts members in the tmux session as new windows, from their settings: the working directory, the brief file (its text is the first message), the product's command line (`claude -n <name> --model <model> --effort <level> "<brief>"`), and an environment that makes the member report to this team (`SCRUM_STATE_DIR`, `SCRUM_NAME`, the Claude Code configuration directory when the member has `configDir`, and this process's `PATH`, because the tmux server's own may lack `gh`). A member that already runs (a window, or a live session) is left alone. `--dry-run` prints what would run, with the brief and the PATH not shown. Permission prompts stay on unless the member has `permissions: "skip"`. Stopping follows (#37).

To use sprint checkpoints and story points (optional), add two Number fields to the board (story points and overrun) and write `sprint` in the configuration:

```json
"sprint": {
  "checkpoints": ["08:00", "13:00", "21:00"],
  "utcOffset": "+09:00",
  "pointsField": "Story points",
  "overrunField": "Overrun",
  "pointBudgets": { "1": 1, "2": 1, "3": 2, "5": 3, "8": 5 }
}
```

A person enters the points before a checkpoint. Only the harness writes "Overrun". How they are counted is in "Sprint checkpoints and story points" in docs/rules.md.

To show it in the statusline, add this at the end of the statusline script:

```sh
SCRUM_LINE=$(echo "$input" | <clone directory>/bin/scrum statusline 2>/dev/null)
[ -n "$SCRUM_LINE" ] && echo "$SCRUM_LINE"
```

## Setting up a machine

On macOS or Linux (the harness needs node 24, `git`, and an authenticated `gh`):

```sh
git clone <this repository> && cd scrum-harness
bin/scrum init --project-id PVT_... --status-field-id PVTSSF_... --repos acme/app --owner-user @alice \
  --techlead TechLead --members SWE1,SWE2 --liaison Liaison     # writes ~/.claude/scrum/config.json (or --state-dir <dir>)
bin/scrum refresh && bin/scrum lint                             # read the board and check the findings
bin/scrum install                                               # add the hooks to ~/.claude/settings.json
bin/scrum schedule install                                      # run the background loop (launchd or systemd)
```

`init` asks nothing and does not overwrite an existing configuration unless `--force` is given. To share the board with other teams, add `--team <option> [--team-field <name>] [--adopts-unassigned]`; for GitHub Enterprise, `--host <host>`; for the work type field, `--work-type-field <name>`. It does not write board scripts, sprint, dispatch, or links sections; add those by hand from `config.example.json` when the team needs them. To find the board's ids: `gh project list --owner <owner>` and `gh project field-list <number> --owner <owner> --format json` (the id of the Status field). Notifications to the owner use a desktop notification on macOS, `notify-send` on Linux when a desktop is reachable, and otherwise a line in `<state dir>/log/notifications.log`.

## Usage

| Command | Meaning |
|---|---|
| `scrum lint [--refresh]` | All findings |
| `scrum team` | Activity of the TechLead and the members |
| `scrum dispatch --once [<name>...]` | For idle members, picks the next work once, writes it to the board, and prints the message to send (for members that are already idle right after dispatch is enabled. The caller sends the message with SendMessage) |
| `scrum ack <rule> <subject> --for 2h --reason "..."` | Silences a finding as an intended exception. A T-IDLE acknowledgement lasts at most 1 hour, and its reason is "Waiting for <owner>'s answer" or "slot HH:MM". S-POINTS-OVER is accepted only when the issue has a comment with the overrun-handling mark (docs/rules.md) dated after the checkpoint that showed the overrun |
| `scrum report --since YYYY-MM-DD` | A summary for the sprint review (how long findings stayed, member idle time, how often it stopped the TechLead, exceptions) |
| `scrum points` | Points, budget, effort, and overrun of In Progress issues (largest overrun first). Below it, estimate versus actual of finished issues (points, budget, checkpoints taken), and the median and range per points |
| `scrum alerts` | Advances the stall detection (E-STALL, Q-EMPTY) once. The system scheduler (launchd or a systemd user timer; `scrum schedule`) runs it every 5 minutes. For how to install it, see "Detecting stalls and notifying the owner" in docs/rules.md |
| `scrum schedule <install\|uninstall\|status\|print> [--name <team>]` | Runs `scrum alerts` every 5 minutes under launchd (macOS) or a systemd user timer (Linux). `print` shows the files and writes nothing |
| `scrum init --project-id ... --status-field-id ... --repos ... --owner-user ...` | Writes a minimal team configuration and the state directory from flags, so a new machine needs no hand-copied config. See [Setting up a machine](#setting-up-a-machine) |
| `scrum link-prs [--dry-run]` | Lists open PRs in the body of the issue each one points to, between the markers (`<!-- scrum-harness:prs -->` and `<!-- /scrum-harness:prs -->`) (the watch runs it too when links.enabled). `--dry-run` rewrites nothing and shows only the plan, the reasons for skipping, and broken markers. See "Linking PRs and issues" in docs/rules.md |
| `scrum checkpoint` | Records the last checkpoint that is not recorded yet, now |
| `scrum request <add\|list\|show\|reply\|close>` | Requests to the owner (questions and proposals). An answer reaches the TechLead as R-ANSWERED (see "Requests to the owner" in docs/rules.md) |
| `scrum board add <N\|repo#N>` | Adds an issue to the board: Status Backlog when it has none and, when the board is shared (`team`), this team's value in the team field. Not an error when it is already there |
| `scrum board move <N\|repo#N> --team <name>` | Hands one of this team's items to another team (it leaves this team's part of the board at the next refresh). `scrum board move --unassigned --team <name>` gives every item with no team to a team, the first step of sharing a board |
| `scrum adapter check [--module <path>] [--calls <file>]` | Checks a board module (the one in `adapters`, or at `--module`) without writing to the tracker: it loads, its ports, the snapshot it reads (shape, references, Statuses), its action reader's patterns, and with `--calls` what the reader makes of given tool calls. See [docs/board-module.md](docs/board-module.md) |
| `scrum runtime` | Called by an Agency node (agency-runtime/1). Reads one JSON request on stdin, and returns the team's state (TeamView), applies an answer to a request, or reports token use by day and person. See [docs/agency-runtime.md](docs/agency-runtime.md) |
| `scrum usage-index` | Reads what the agents' transcripts gained since the last run into the usage index. `scrum runtime` starts it in the background when the index is stale; run it by hand to build the index before the first call |

`bin/scrum` keeps node's compile cache in `<state dir>/cache/node-compile` (set `NODE_COMPILE_CACHE` to put it elsewhere), so every call after the first skips compiling the harness's modules: about 0.11 seconds of user CPU instead of 0.32 for `scrum runtime` on a board of 150 items.

State is kept in `~/.claude/scrum/` (change it with `SCRUM_STATE_DIR`). Errors go to `~/.claude/scrum/log/errors.log`.

## Development

```sh
pnpm test        # node:test
pnpm typecheck   # tsc
```

The source holds no values of a specific board or team. Values live only in the configuration file.

Connections to external systems are split into ports and adapters. Dependencies point only from adapters to the core.

- `src/ports/`: the types of what the core needs from the outside (reading and writing the board, reading actions, issues, PRs and branches, sessions, transcripts, notifications).
- `src/adapters/<system>/`: the implementations of the ports. `github/` (gh and the configured scripts), `claude-code/` (`~/.claude/sessions` and the transcripts under `~/.claude/projects`), `macos/` (osascript, launchd), `linux/` (notify-send, systemd).
- `src/wiring.ts`: builds the adapters from the configuration and hands them to the core as ports. The feature folders of the core (`board/`, `team/`, `sprint/`, and so on) do not import adapters.
- Tests pass the fake ports of `test/fake-ports.ts`, so they never reach an external system.

## License

Either MIT or Apache-2.0, at your option ([LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE)).
