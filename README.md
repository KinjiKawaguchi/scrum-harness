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
| `launch` | How the team's members are started and found (optional). `tmuxSession` (the tmux session with one window per member, named after the member), `defaults` and `members` (per member: `dir`, `brief`, `product`, `model`, `effort`, `permissions`; `permissions: "skip"` starts a member without permission prompts and is never a default; `product` is `claude-code` or `codex`; `sandbox` is Codex's `-s`; `configDir` is a Claude Code configuration directory), `ignoreWindows` (windows that are not members), `funding` (see "Which account a member runs under" under Members). A key that is not known, or a value of the wrong shape, makes the section ignored. See [Members](#members) |
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

`launch` is the one place that says where each member runs, so the `members` list and what runs do not drift apart. `scrum member list` shows, for the lead, the members, and the liaison, whether each one runs (a window in the tmux session, or a live session record, with its activity), and reports both kinds of drift: windows that are not in the configuration, and listed members that are not running. Without a `launch` section it judges from the session records only. `scrum member start <name...>` (or `--all`, for every member that has launch settings) starts members in the tmux session as new windows, from their settings: the working directory, the brief file (its text is the first message), the product's command line (`claude -n <name> --model <model> --effort <level> "<brief>"`), and an environment that makes the member report to this team (`SCRUM_STATE_DIR`, `SCRUM_NAME`, the Claude Code configuration directory when the member has `configDir`, and this process's `PATH`, because the tmux server's own may lack `gh`). A member that already runs (a window, or a live session) is left alone. `--dry-run` prints what would run, with the brief and the PATH not shown. Permission prompts stay on unless the member has `permissions: "skip"`. `scrum member stop <name...>` asks an idle member to exit (it types `/exit` into its window); a member that is busy or waiting at a permission prompt is left alone unless `--force`, which closes its window.

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


**Codex members.** A member with `product: "codex"` is started with `codex` instead of `claude`, with the same hooks as a Claude Code member passed at the start with `-c hooks.<Event>=[...]` (the same events and limits; nothing is written under `~/.codex`), and with `SCRUM_NAME` and `SCRUM_STATE_DIR` in its environment, which reach the hooks. Codex gives its hooks the same input as Claude Code, so the harness's write guard works for it: a command a hook denies is not run. Two things differ. The hooks are trusted for the session (`--dangerously-bypass-hook-trust`), because nobody can answer a trust prompt in a member's window; this also trusts a hook that the member's project defines. And the reason a hook gives does not reach the model, which only learns that a hook blocked the command. Approvals and the sandbox follow the user's Codex configuration unless the member says `sandbox` (`read-only`, `workspace-write`, or `danger-full-access`); `permissions: "skip"` bypasses both and is never a default. A Codex session that is started alone has been seen to hang before its first hook, so a Codex member has a **startup watchdog**: after `scrum member start` it has `startupSeconds` (default 60) to show a sign of life (a hook heartbeat or a live session record); if it does not, its window is closed and it is started again, `startupRetries` more times (default 2), and then it is reported as the finding M-START-FAILED. Any member can have the watchdog by setting `startupSeconds` (5 to 600) and `startupRetries` (0 to 5); `--no-wait` skips it. Give an automated `codex exec` its own timeout and retry. The TechLead stays Claude Code: the wake-up of an idle session (`asyncRewake`) has not been shown for Codex.

**Which account a member runs under.** When one person holds several subscriptions, the node (`agency`) decides which one a new session starts on, by the usage of each. Set `launch.funding` to the node's program and its first arguments (`"command": ["/usr/local/bin/agency", "funding"]`, an absolute path owned by you and not writable by others; optional `"dir"` is the node's data directory). Then `scrum member start` runs `<command> pick --tool claude` (`codex` for a Codex member) before it launches a member and sets what the answer's `env` names (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`, and nothing else) for that member's session; the start prints which source it is on and why, and `scrum member list` shows the source of each running member. `--dry-run` asks too and starts nothing. A running session keeps the login it started with; a member that restarts continues from the board and the harness's own state.

The node's list of sources (`<command> list`) is read at each `scrum member start` and `scrum refresh`, and the login directories in it are kept in `cache/funding-dirs.json`. Session records and transcripts of those directories are read like the configured `claudeConfigDirs` (and the `CODEX_HOME` of Codex sources), and `scrum install --all` writes the hooks into each Claude Code directory. If the node cannot be asked, the kept list stays.

**Moving a running member.** The pick only decides new starts, and members run for days, so a member that started under its threshold keeps spending the same login after it passes. `scrum member move [<name>...] [--dry-run]` restarts **one** member per call on the source the node picks now, continuing its conversation (`claude --resume <session id>` on the new login, with a short note saying it was moved as the first message). It moves a member only when all of these hold, and says which one stopped it otherwise (`--dry-run` shows the same without moving anything):

- The member's source (recorded when `scrum member start` started it) is past its threshold or blocked, as the node's `list` says (`overThreshold`, `blocked` per source; when the node says neither, nothing moves), and the node picks another source with state `ok`. A source that is merely not the first in the list is not a reason: that would restart members each time the first source's window resets.
- The member is a Claude Code member without its own `configDir`, and not the lead (the lead only when named).
- Its session has been idle for 60 seconds (checked again just before it is asked to exit), the picked login has the harness's hooks, and the conversation is visible under the picked login (a shared `projects`, below).

**Automatic moving.** With `"autoMove": true` in `launch.funding`, `scrum refresh` (which the scheduled job runs) does the same one-member move: at most one member, and at most one try every 30 minutes (the time of a try is kept in `cache/member-moved.json`, whether or not the member came up), so a source that hovers near its threshold does not cause a string of restarts. It prints nothing when there is nothing to move, and `automatic move: ...` with the same lines as `scrum member move` when it tried. It is off unless set, and `scrum member move --dry-run` shows what it would do.

If the member does not exit within 15 seconds it is left running; if it does not come up on the new login it is started again on the old one. Members that were not started by `scrum member start` have no recorded source and are skipped, so start the team from its `launch` section.

**Members that were started some other way.** `scrum member move` and the source shown by `scrum member list` need a record of where each member started, which `scrum member start` keeps. For members that already run (started by a script, say), `scrum member adopt <name>... | --all [--source <name>]` writes that record from the member's live session record, without restarting it: on the one Claude source the node lists for the default login, or on the source named with `--source` (the harness cannot tell which login a session runs under, so say so when it is not the default one). A member that is already recorded, does not run, or has no live session is left alone.

`scrum member start <name> --resume` starts a stopped member with its latest recorded session (`claude --resume <id>` on the login the node picks) and a short note ("you were started again") instead of its brief. It refuses when the member has no recorded session, when that conversation is not visible under the login (see the shared `projects` below), and for a Codex member. Without `--resume` a start is a new conversation with the brief.

**The weekly budget.** The org sets a weekly budget (API-priced dollars, calendar week) for a team and for the org; the node reports it, and the harness acts on it. Set `launch.budget` to the node's program and the names that say which budget to ask for: `"budget": { "command": ["/usr/local/bin/agency", "budget"], "org": "<org id>", "team": "<team id>", "warningModel": { "claude-code": "<model>", "codex": "<model>" } }` (an absolute program owned by you and not writable by others; optional `"dir"` is the node's data directory). The cap itself is never in this configuration. The harness asks `<command> status --org <org> --team <team>`, which answers `{ weekStart, team: { capUsd?, spentUsd, state }, org: { ..., partial } }` with `state` `ok` (below 80%, or no cap), `warning` (80% up to 100%) or `over` (the team is over when its own cap or its org's is). `scrum refresh` keeps the answer in `cache/budget.json`; an answer older than 3 hours is not acted on, and a node that cannot be asked never stops a team.

- At `warning`, `scrum member start` starts the member on its cheaper model: its own `warningModel`, else the one for its product in `launch.budget`; a running member keeps its model (a session cannot change it). With none set the model is left alone, and the start says so. The finding B-BUDGET-WARNING (low) shows the spend.
- At `over`, `scrum member start` does not start a member (a restart of one that ran counts as new work), and the finding B-BUDGET-OVER (high) tells the TechLead the spend and when the week ends. Running members are not told; they finish their task. `scrum member move` is not affected.
- Both go away by themselves when the node says `ok` again (a new week, or a higher cap).

**Setting up a second login (recommended).** A second Claude Code login needs its own `CLAUDE_CONFIG_DIR` (it holds the credentials), but the rest can be the first one's, by symlink, so that a member restarted on the other login keeps its instructions and memory and `claude --continue` finds its transcript:

```sh
mkdir -p ~/.claude-accounts/personal-2
cd ~/.claude-accounts/personal-2
for item in settings.json CLAUDE.md rules hooks skills plugins projects; do ln -s ~/.claude/$item $item; done
CLAUDE_CONFIG_DIR=~/.claude-accounts/personal-2 claude   # then /login with the second account
```

Because `settings.json` is shared, the harness's hooks are already there (the check that refuses a login without them follows the symlink), and `scrum install --dir` on either directory changes both. The trade-off: both logins then share history, memory, and settings; a transcript written under one is read under the other, so nothing separates the two accounts' work except which one is billed. Do not link the credentials (`.credentials.json`, or the keychain entry macOS keeps per directory): each login keeps its own. Keep the logins to one person's own subscriptions.

- A Claude Code member with its own `configDir` is pinned to it, and the node is not asked.
- If the node cannot be asked (the program is missing, fails, answers something that is not the agreed JSON, or takes more than 20 seconds), the member starts on its own settings and the start says why. A node that is down does not stop the team.
- If every source is at its limit (`none`), the member is not started. The same happens when the picked login for a Claude Code member has no harness hooks: its write guard and watchdog would not see it, so it would run unguarded and unwatched. The start says which, and names `scrum install --dir <dir>`, which you run (the harness never edits another account's settings). Both show in `scrum member list` and as the finding M-SOURCE-REFUSED until the member runs.

**Adding a Codex member to a team**, step by step (tried on Codex 0.151):

1. Install `codex` and sign in (`codex login`). The member uses that login, so its work counts against that plan.
2. Add the member's name to `members` in the team's `config.json`, and give it launch settings. The working directory is where it works, usually a checkout of its own:

   ```json
   "launch": {
     "tmuxSession": "team",
     "members": {
       "CodexA": {
         "product": "codex",
         "dir": "~/work/app-wt/codex-a",
         "brief": "~/work/briefs/CodexA.txt",
         "sandbox": "workspace-write",
         "trustDirectory": true
       }
     }
   }
   ```

   `brief` is a text file whose content is the first message. `model` and `effort` are optional; without them Codex uses the user's own. `trustDirectory` is explained below.
3. See what would run: `scrum member start CodexA --dry-run`. It prints the directory, the environment, and the command (the brief is not printed).
4. Start it: `scrum member start CodexA`. It opens a window of the tmux session and waits for the member's sign of life (the startup watchdog). If there is none in time it closes the window and tries again, then reports the finding M-START-FAILED with what the window showed.
5. Check it: `scrum member list` (does it run?) and `scrum team` (is it busy or idle?). Its token use appears in `tokenUsage` under its name, in tokens and at 0 dollars.
6. Stop it: `scrum member stop CodexA` asks an idle member to exit and closes the window Codex leaves open; a busy member is left alone unless `--force`.

Things to know:

- **The trust question.** The first time Codex runs in a directory it asks "Do you trust the contents of this directory?" and waits; no command-line option or `-c` setting skips it, so a member started without anyone there stays at the question and the watchdog reports it (with the question as what the window showed). With `trustDirectory: true` the harness answers "Yes, continue" for the member's own directory, which you chose by configuring it; Codex then records the trust in `~/.codex/config.toml`, as it does when a person answers. Trusting a directory lets Codex load that directory's project-local config, hooks, and exec policies. It is never a default. The alternative is to run `codex` once in the directory yourself and answer the question.
- **The hooks and the write guard** are passed at the start, so nothing is installed. A command that the harness's guard denies is not run. The reason does not reach the model.
- **`/exit` needs a pause before Enter**, which `scrum member stop` does for you. After a Codex session ends, Codex leaves a list of sessions in the window; the harness closes it once the session's end is recorded.
- **Approvals and the sandbox** follow the user's Codex configuration unless the member sets `sandbox`. A Codex member that stops to ask for an approval waits in its window for a person.
- The lead stays Claude Code.