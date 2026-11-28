# Rules

The operating rules of the board, in a form a machine can check. Values (the names of Statuses, the limits, and so on) are read from `~/.claude/scrum/config.json`.

The severity decides how a finding is reported.

| Severity | How it is reported |
|---|---|
| High | Stops the end of the TechLead's turn, once. Wakes the TechLead if it is waiting |
| Medium | When it first appears, injected at the next hook (after a tool call, or at a prompt). Wakes the TechLead if it is waiting |
| Low | Only in the summary at the start of a session and in `scrum lint` |

## The board

| Rule | Severity | Condition | Fix |
|---|---|---|---|
| B-WIP-OVER | High | The open issues In Progress exceed the limit (`wipLimit`). Epics (issues with sub-issues, or that other items name as their parent) are not counted, as nobody works on an epic itself; the guard that refuses a move, the hand-over, and this rule count the same way, and the refusal names the items it counted and the epics it left out | Start with the blocked ones, and move them back to Backlog |
| B-DOING-NO-ASSIGNEE | High | An issue is In Progress but has no assignee | Assign it. If you cannot decide, move it to Backlog |
| B-NO-TEAM | Medium | On a shared board (`team` is set), for the team that has `adoptsUnassigned`: an open issue is on the board with no team | `scrum board move <ref> --team <name>` |
| B-CLOSED-NOT-DONE | Medium | A closed issue's Status is not Done | Set Status to Done |
| B-OPEN-DONE | Medium | An open issue is Done | Close it, or move it back to In Progress or Backlog |
| B-PR-STATUS | Medium | A PR has a Status | The `gh project item-edit ... --clear` shown in the finding |
| B-NO-STATUS | Medium | An open issue has no Status | Set Status to Backlog |
| B-OFF-BOARD | Medium | An open issue is not on the board | Add it to the board and set Status to Backlog |
| B-UNREADABLE | Medium | The content (number) of issue and PR items cannot be read. B-OFF-BOARD is not judged meanwhile | `scrum refresh`. If it continues, see `~/.claude/scrum/log/fetch-failed-*` |
| B-SNAPSHOT-STALE | Medium | The board copy is older than three times `refreshSeconds` (the refresh is failing) | See `~/.claude/scrum/log/errors.log` and `fetch-failed-*` |
| B-NEXT-BLOCKED | Medium | An item in Next is blocked (its reason is not None) | Put it in Backlog and leave the reason |
| B-JUDGE-OWNER | Medium | An item is blocked on a decision but its Owner is not `ownerUser` (it does not show in that person's view) | Set Owner to `ownerUser` |
| B-SINCE-MISSING | Medium | An item is blocked but has no blocked-since date | Enter the date the block began |
| B-REASON-MISSING | Low | The blocked reason is empty | Set the reason to None |
| B-SINCE-STRAY | Low | The reason is None but a date remains | Clear the blocked-since date |
| B-BLOCK-STALE | Low | A block has lasted more than `staleBlockDays` days | Check what it waits for |

Issues by an author in `excludeAuthors` (a separate development body) are not checked.

For B-OFF-BOARD, when it fetches the board copy, the harness reads one by one the open issues that did not appear in the board's page list (`projectItems`). If one is on the board it adds it as an item, and only then judges. An item that is on the board can stay out of both the list and the total for hours after it was added; even then the issue on the board is not reported by mistake. When an open PR's item is missing from the list, it is added by the same reading (B-OFF-BOARD still applies to issues only; an open PR that is not on the board is not added and not reported). If reading one of them fails, the board copy is not rewritten (`src/adapters/github/off-board.ts`).

The fix text uses the configured `scripts` that rewrite the board, if there are any (for example `set-status 123 Done`). Otherwise it is given in words. The shape of the script arguments is described at `BoardScripts` in `src/config.ts`.

## Member activity

Activity is decided from `~/.claude/sessions` (Claude Code's session records) and the heartbeats that members' hooks write (`~/.claude/scrum/team`). If several sessions have the same name, the one that took the name later wins (as in ListAgents).

| Rule | Severity | Condition | Fix |
|---|---|---|---|
| M-CONTINUED | Medium | A Codex member with `continuation` had been idle at its prompt for its `afterMinutes`, and the harness typed its continuation text into its window (once for each stretch of idleness). The message says which case it was: the issues In Progress, or none | Nothing, unless it stays idle; with no issue In Progress, give it work or tell it to stop. It goes away after an hour |
| B-GRAPHQL-LOW | Medium | The last board read says that less than a fifth of the hour's GraphQL points is left (every harness, member, and daemon that uses the login spends from them, and past it GitHub refuses reads and, earlier, the creation of comments and pull requests). It is not shown after the reset time or for a reading an hour old | Hold back what reads GitHub in bulk until the reset, and check that the teams of the machine share one board read (`SCRUM_SHARED_DIR`) |
| B-GRAPHQL-USE | Medium, High | The harness's own calls took at least a quarter (High: half) of the hour's GraphQL points, counted from the calls it made (every team of the machine, with what each asked; a call that does not state its cost counts as one point). The finding names the calls that cost the most | Teams on one machine share one board read (`SCRUM_SHARED_DIR`); raise `refreshSeconds`, or find what calls so often |
| T-STANDBY-BUSY | Medium | A member the lead put on standby (`scrum member standby`) has been busy for `untrackedMinutes` with no item assigned to it in In Progress or Next, so the mark is stale | Put what it is doing on the board and assign it, or end the standby with `scrum member standby <name> --off`. A member on standby raises no T-IDLE and no T-BUSY-UNTRACKED |
| M-OVER-THRESHOLD | High | A member runs on a subscription that is past its weekly threshold (or blocked) and the harness could not move it off: no source is under its threshold, it is busy, its conversation cannot follow, or its move was tried a moment ago. The message names the member, the source, how long, and why | The owner's rule is that no member keeps running on a subscription past its budget: move it with `scrum member move <name>` once a source is under its threshold, or stop it. It goes away when the member is on a source that is under its threshold |
| M-START-FAILED | Medium | A member was started by `scrum member start` with a startup watchdog (a Codex member by default), and showed no sign of life after its start and its retries, and still has no live session | Look at its window (tmux), then `scrum member start <name>` again. It goes away when the member shows a sign of life |
| M-SOURCE-REFUSED | Medium | The last `scrum member start` of a member was refused by the funding check (every funding source is at its limit, or the login the node picked has no harness hooks), and the member has no live session | Deal with the reason (for the hooks, `scrum install --dir <dir>`), then `scrum member start <name>` again. It goes away when the member runs, or when a start of it is not refused |
| M-API-ERROR | High | A member's last reply was an API error, so it is stuck although it looks idle: it has been idle 3 minutes or more with the error as the last thing in its transcript, or it is busy and the last two replies in a row were errors | Look at its window (tmux). If the context is too long, run `/compact` in it, or restart it with `scrum member stop <name>` and `scrum member start <name> --resume`; check the Claude Code version it runs in `scrum member list`. The member's T-IDLE is not reported while it is raised. It goes away when the member answers with a reply that is not an error |
| B-BUDGET-OVER | High | The node says the team's weekly budget is used: its own cap, or its org's (`launch.budget`; the answer is at most 3 hours old) | Raise the cap in the org definition, or wait for the reset (the first day of the next week). No new member is started until then; running members finish their task. It goes away when the node says `ok`. While it is raised, a member's idleness (T-IDLE) is not reported, because the harness holds new work back on purpose |
| B-BUDGET-WARNING | Low | The team's weekly budget is at 80% or more | New members start on the cheaper model (`warningModel`), where one is set. It goes away when the node says `ok` |
| T-IDLE | High | A member has been idle for `idleMinutes` minutes or more | Assign work (with `dispatch` enabled, the harness hands work to an idle member who has no acknowledgement; see "Handing the next work to idle members" below). For an intended wait, `scrum ack T-IDLE <name> --for 1h --reason "Waiting for <owner>'s answer"`. A T-IDLE acknowledgement lasts at most 1 hour, and its reason is "Waiting for `ownerLabel`'s answer" or "slot HH:MM". Spare context capacity cannot be a reason |
| T-WAITING | High | A member has been stopped at a permission prompt for `waitingMinutes` minutes or more | Tell the person named by `ownerLabel`. Do not approve on their behalf from the TechLead |
| T-BUSY-UNTRACKED | Low | A member has been active for `untrackedMinutes` minutes or more but has no In Progress issue assigned | Assign the issue they are working on |

## Handing the next work to idle members (A-DISPATCH, no LLM)

It runs only when `dispatch.enabled` is true (by default it does not). Finding an idle member and giving them work is not the TechLead's judgment; it is the harness's job.

When a member has been idle for `idleMinutes` minutes or more and none of the following applies, the harness picks the next issue and hands it over. (If the member has an In Progress issue of their own that is not blocked, nothing is handed over and the member is nudged; see "Nudges" below.)

- A valid T-IDLE acknowledgement exists. A "slot HH:MM" acknowledgement does not stop it until 15 minutes before the slot starts.
- The member has not moved since the last new issue was handed over (the idle period began before the time of the hand-over).
- The member is not in `dispatch.members` (or in `members` when that is absent).

**Order of choice** (a fixed order; no LLM):

1. In Next on the board, assigned to this member.
2. In Backlog, assigned to this member (blocked reason None).
3. In Next, with no assignee.

Within the same group: the board's number field (`dispatch.orderField`; smaller first; empty last), then the child of the Epic with the fewest people active on it, and last the issue number.

**What is skipped**: items blocked for a reason other than None; everything when In Progress has reached `wipLimit` (nothing is handed over); items with a label in `dispatch.skipLabels` (a "do not hand over" mark); items whose title starts with `release/<number>` (a release issue is cut out by a person, so the hand-over text does not fit); issues of a repository other than `defaultRepo` (the scripts that rewrite the board point only by number); PRs; closed issues; and issues by an author in `excludeAuthors`.

**How it is handed over**: with `scripts.setAssignee` and `scripts.setStatus` it sets the assignee to that member and Status to In Progress (the scripts are looked up in `dispatch.scriptDir`), and sends a fixed message to that member's session (the watch process of a member's Stop and SessionStart wakes it with exit 2 of asyncRewake, as for the TechLead). The message has the issue's number and title, that the branch is cut from `origin/<dispatch.baseBranch>`, where the PR goes, who merges (`techlead`), and `dispatch.notes`. The board copy is read again inside the lock, so that the same issue is not handed to two people. If a script fails, nothing is recorded and the board copy is not rewritten, and it does not try again for 5 minutes.

**Nudges**: if an idle member has an In Progress issue of their own that is not blocked (its reason is None), no new issue is handed over; the harness sends a message that says to continue it ("continue the In Progress #N"), and does not rewrite the board. This keeps the In Progress count from growing, and adding other work to someone who only looks idle while waiting for CI or review would slow both. After the last send, up to 2 times, every `idleMinutes`, **while the work does not progress** (right after a new issue is handed over it also waits `idleMinutes`). Whether work progressed is decided by comparing the marker at the time of the nudge with the current marker of the issue. The marker is the board's Status, blocked reason, assignee, and blocked-since date, plus what gh reads: the number of issue comments, the tip of the linked branch, and the number, state, and tip commit of the issue's PR (when gh cannot be read, only the board's marker is compared). The PRs are narrowed so that someone else's PR is not picked up: if there is a linked branch (created when the work was handed over), only PRs from that branch; otherwise only PRs whose number in the parentheses of the title or at the start of the branch name matches the issue. If the marker changes, the count starts again. **While work is progressing, it does not nudge**: if the marker changed from the one seen before (a comment was added, the PR was pushed to), or `idleMinutes` have not passed since the marker last changed, it waits, even before the nudge limit. The marker seen is kept per member and per issue in `~/.claude/scrum/cache/dispatch-seen.json`, and A-NUDGE-IGNORED compares with the same marker (the board's marker is the current board; gh's marker is the one seen last). Even if after a nudge the member returns to idle after a short turn, or the idle period changes, it does not recount (it counts that member's nudges for that issue in the last 3 hours). If the In Progress issue is blocked (its reason is not None), or there is none, the next one is handed over. Even when In Progress has reached `wipLimit`, a nudge is sent (the limit is checked only when handing over a new issue).

| Rule | Severity | Condition | Fix |
|---|---|---|---|
| A-DISPATCHED | Medium | Work was handed to an idle member automatically (shown for 2 hours after the hand-over). With who got what | If the hand-over is wrong, fix the assignee and Status and tell the member. If you do nothing, it proceeds as is |
| A-NUDGE-IGNORED | Medium | Two nudges were sent with no progress (in the last 3 hours, for that member and that issue) and the member is still idle (one finding for each continued nudge) | If the In Progress work is really waiting, have them set the blocked reason (then the next work is handed over). Otherwise tell the member directly |

**After it applies, check that gh's marker can be read**: if gh cannot be read, the comparison uses only the board's marker, so movement in comments or PRs does not count as progress. After the first nudge following the rollout, check that `progress.github` in that nudge's record in `~/.claude/scrum/log/dispatches.jsonl` is not `null` (that it is a JSON string containing the comment count and so on). If it is `null`, check gh's authentication (`gh auth status`) and whether `gh` can be called in the watch process's PATH. The standard error of a failed gh does not get into the message that wakes the member; it stays in `errors.log`.

**The write guard and how it counts**: before handing over, it passes the board's write guard (`checkGuard`). The guard and the hand-over count In Progress in the same way (In Progress items by excluded authors are also counted). If the guard does not pass, nothing is handed over.

**Checking T-IDLE acknowledgements**: the check of the longest 1 hour and of the fixed reasons (exactly "Waiting for `ownerLabel`'s answer" or "slot HH:MM") is in effect from the moment it applies, whether or not `dispatch.enabled` is set (`scrum ack` refuses what does not pass). A saved acknowledgement that does not pass the check (one made before the check existed, with a long expiry, a reason such as spare capacity, or characters after the reason) stops neither the automatic hand-over nor the T-IDLE finding.

**Moving already idle members once after it applies** (`scrum dispatch --once [<name>...]`): the watch starts only at a member's Stop and SessionStart, so a member who is already idle when `dispatch.enabled` is turned on is not handed work until the next Stop. This command does it once from outside the watch: for the members it is given (only that member if a name is given), it chooses, rewrites the board, and prints the message to send. It cannot wake a member's session, so you send the printed message to that member's session with SendMessage. For a member it does not send to, it prints the reason on one line (not idle, idle too briefly, an acknowledgement exists, nothing to hand over, the limit).

The record of hand-overs is in `~/.claude/scrum/log/dispatches.jsonl` and `events.jsonl` (`dispatched`). To stop it, set `dispatch.enabled` to false.

## Linking PRs and issues

So that you can go from a PR to an issue and from an issue to its PRs. There are three ways, and this harness has the first two.

1. **When handing over, create a branch linked to the issue** (the `dispatch.linkedBranchPrefix` setting; without it, none is created). When handing work to a member, it creates `<prefix>/<number>` from the tip of `origin/<dispatch.baseBranch>` with GitHub's createLinkedBranch. A PR from that branch shows in the issue's Development field even if its base is not the default branch (even a PR to develop) (I read, through the API, that the PR appears in `linkedBranches[].ref.associatedPullRequests` on the issue's side). If the issue already has a linked branch, it does not create one and hands over the first one (the message says the base may be old, so check that it is not behind origin before working). These gh calls are inside the hand-over lock, so each is cut off after 15 seconds (at most 2 calls). If it could not be created, the hand-over is not stopped, and the message says "could not be prepared". From the PR's side this link does not take you to the issue (`closingIssuesReferences` is empty). The message tells the member to write `#N` in the PR body.
2. **List the PRs in the issue body, between markers** (the `links` setting, `scrum link-prs`). It fills in for PRs that were not made from a linked branch (existing ones, stacked ones).
   - **What it reads**: for open PRs, the `#N` in the parentheses of the title (`feat: x (#123)`), the number at the start of the branch name (`feat/456-...`; only when the number is followed by `-`, `_`, `/`, or the end), and the `#N` on lines of the body that start with `Closes`, `Fixes`, `Resolves`, or `Refs` (it does not read inside code fences). It does not read any `#N` elsewhere in the body (a number written for context; one PR would then line up under many issues).
   - **How it writes**: only between `<!-- scrum-harness:prs -->` and `<!-- /scrum-harness:prs -->` in the issue body, as one line, `PRs in progress (automatic): #<number> (title) / #<number> (title)`. It does not change a single character outside the markers (a section a person wrote, "## PRs in progress", is not touched either; if there are no markers it adds a pair at the end of the body). When no PR points to the issue any more, it removes the pair. If the content is the same, it does not rewrite. For the title, it removes a trailing `(#N)` with its parentheses, removes `#N` and `@`, and cuts at 60 characters (so as not to add a mention of another issue or a mention notification).
   - **Guards so it does not break things**: a body with only one of the markers, two or more pairs, or markers in reverse order, and a body with an unclosed code fence (a marker added there would be inside the fence and unreadable, and would be added every run) are not rewritten; they are shown in the output of `scrum link-prs` and in `events.jsonl` (`link-broken`). A marker inside a code fence is not counted. Just before writing, it reads the issue body again, and if it differs from when the plan was made (a person edited it) it does not write that time (`link-skipped`). It does not write closed issues either. The body before writing is kept in `log/links-before.jsonl` (so it can be rolled back). The body is passed with `-f`.
   - Dependabot authors and `release/` and `sync/` branches are not counted (`links.skipAuthors`, `links.skipBranchPrefixes`). The TechLead's watch process runs it every `links.intervalMinutes` (default 30 minutes), and rewrites at most `links.maxEditsPerRun` issues in a run across all repositories (default 20; in the order of the configured repositories, then by ascending issue number; ones skipped because a person was editing also count). `scrum link-prs --dry-run` shows only what it would rewrite.
3. A check that a PR body must have the number of an open issue is not the harness's; each repository's CI has it.

## Detecting stalls and notifying the owner (E-STALL, Q-EMPTY, no LLM)

It runs only when `alerts.enabled` is true (by default it does not). The harness decides who is told what; the liaison session is only a hand that sends a fixed message, and does not judge.

| Rule | Severity | Condition | Fix |
|---|---|---|---|
| E-STALL | High | An Epic that needs someone moving (it has an open child in Backlog, Next, or In Progress; it counts even if all the children are in Backlog) has had nobody moving it (a person assigned to an In Progress child whose session is busy) for `alerts.epicStallMinutes` minutes (default 60) | Get the assignee moving. If all the In Progress children are waiting on the owner's decision (`reasonJudge`), the owner is told, with the pending question attached |
| Q-EMPTY | High | A member who is idle, has no acknowledgement, and is in the set to hand work to has no issue to hand over (no candidate in Next or Backlog, or In Progress has reached `wipLimit`). It shows from when it is found (when the reason changes, it is counted again from then. If a member who was idle because In Progress was at the limit changes to having nothing to hand over, the 30 minutes of Q-EMPTY-OWNER count from there). **It runs only when `dispatch.enabled` is true** (the set to hand work to, and whether anything can be handed over, use the dispatch settings) | Line up issues in Next, or in the Backlog assigned to that member (set the assignee and the order). The TechLead lines them up |
| Q-EMPTY-OWNER | High | A Q-EMPTY where the issues ran out (no candidate) has continued for `alerts.emptyEscalateMinutes` minutes (default 30). A Q-EMPTY that cannot hand work over because In Progress is at the limit is not that the work ran out, so it shows only to the TechLead and does not count here | Lining up issues clears it. The owner is told too (the same member at most once per `alerts.emptyPushMinutes`, default 60 minutes) |

These Epics are not counted: an Epic whose children are only waiting for release or Done (the work is finished), an Epic that is closed on the board, an Epic whose own author is in `excludeAuthors` (a separate development body), and an Epic parked on purpose. The mark of a parked Epic is a label on the Epic itself (`alerts.parkedLabels`, default `epic:parked`), which the TechLead adds (the rule is to write the reason in the Epic's body when adding it; the harness does not read the body, only the label). An Epic that is not on the board has no readable labels, so it is counted. The watch process remembers the time it stopped in `~/.claude/scrum/cache/alerts-state.json` (it is erased when it moves, and counted again if it stops again). The parents and labels of an Epic's children are fetched from the board when `dispatch` or `alerts` is enabled.

**How it is told** (a finding for the TechLead goes in, like other findings, by the watch's wake-up and by hooks).

- **Notifying the owner** (E-STALL and Q-EMPTY-OWNER): it sends the liaison session the message "Send the owner one PushNotification (no sound). Use this text as it is". If all the In Progress children of an E-STALL are waiting on a decision, it adds the numbers of the waiting children and has the liaison add one line with the question. The owner is told about the same E-STALL at most once per `alerts.epicPushMinutes` (default 1440 minutes, one day). A new E-STALL that appears right after a notification is not sent to the owner; the liaison is told in one line, "already notified, so not sent" (the TechLead still gets it at its current severity). If it is still stopped after the interval, the new notification then goes to the owner. The harness also shows the same content directly as a desktop notification (on macOS `display notification` of `osascript`, no sound; on Linux `notify-send` when it can reach a desktop, otherwise one line in `<state dir>/log/notifications.log`), so that it reaches the owner even when the liaison is working. The text is passed as arguments (argv) and not embedded in an AppleScript string or a shell line. Setting `alerts.isDesktopEnabled` to false stops only the desktop notification.
- **A line for idle members**: when a member has been idle for `idleMinutes` minutes (the same point as T-IDLE), it sends the liaison one line. It sends even if there is a T-IDLE acknowledgement. It writes the acknowledgement's reason and end, the work the harness sent (handed over, nudged), and that there is no issue to hand over. It shows no desktop notification.
- **Notices from one evaluation are combined into one**: even if several Epics that stopped during the night become E-STALL at once, the owner gets one PushNotification and one desktop notification. There is one line for each, with the reason it is stopped (a child waiting on the owner's answer, the reasons of the In Progress children, or no In Progress child and the number of children). E-STALL and Q-EMPTY-OWNER go into the same one. The mark that it was sent is put on all that were combined.
- **Waiting for permission (waiting) does not count as moving**. The people moving are only those assigned to an In Progress child whose session is busy.
- A finding that has an acknowledgement (`scrum ack E-STALL <Epic> ...`, `scrum ack Q-EMPTY <name> ...`) is not sent to the owner either. The same notification is not sent again until it recovers and happens again.

**Run the detection every 5 minutes with the system scheduler** (`scrum alerts`): the life of the watch process (50 minutes) is shorter than the limit of E-STALL (60 minutes), and the watch stops on a night when everyone is quiet, so detection would stop. `scrum alerts` (one round of the watch: it refetches the board copy and shows a desktop notification if not shown yet; no LLM) is run every 5 minutes by launchd on macOS and by a systemd user timer on Linux. `scrum schedule` installs it:

```
scrum schedule print       # shows the files that install would write, and writes nothing
scrum schedule install     # writes them and starts the job
scrum schedule status
scrum schedule uninstall
```

Neither scheduler passes on the login shell's PATH, so `install` reads the locations of node and `gh` from the current shell and writes them into the job's PATH. It stops if `gh` is not found. If the state directory is not `~/.claude/scrum` (`SCRUM_STATE_DIR`), the job gets the same variable. To run the jobs of several teams on one machine, give each its own name with `--name <team>` (and its own `SCRUM_STATE_DIR`). Run `install` again when you change the location of node or `gh` (for example when you switch version managers). Do not change the life of the watch.

- **macOS (launchd)**: writes `~/Library/LaunchAgents/local.scrum-harness.alerts.plist` (with a name: `local.scrum-harness.<team>.alerts.plist`), runs `launchctl bootstrap gui/$(id -u) <file>`, and runs the job once with `launchctl kickstart -k`. The log is `<state dir>/log/alerts-launchd.log`. Check with `scrum schedule status`: it has run if the log shows that it advanced the stall detection (or "alerts is not enabled" if `alerts.enabled` is false) and `last exit code = 0`. `uninstall` runs `launchctl bootout` and removes the file.
- **Linux (systemd)**: writes `scrum-harness-alerts.service` and `scrum-harness-alerts.timer` (with a name: `scrum-harness-<team>-alerts.*`) in `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`, runs `systemctl --user daemon-reload`, and `systemctl --user enable --now <timer>`. The log is `<state dir>/log/alerts-systemd.log`. A user timer runs only while the user has a session; to keep it running when logged out, run `loginctl enable-linger "$USER"` once. `uninstall` runs `systemctl --user disable --now` and removes the files.

**The liaison's watch**: if you write the liaison session's name in `alerts.liaison`, the watch process at the Stop and SessionStart of the session with that name refetches the board, advances the stall detection, and wakes the liaison with exit 2 when there is a notice to send to the liaison. The TechLead's and the members' watch processes also advance the same detection and show desktop notifications (so it reaches the owner even when the liaison is not running).

The records are `alert-desktop` and `alert-liaison` in `events.jsonl`. To stop it, set `alerts.enabled` to false.

## Requests to the owner (R-ANSWERED)

The team asks the owner for answers and decisions with requests, not with chat messages, so that the open questions stay visible. A request is a question (with options if useful) or a proposal (options and a Markdown document). It is stored in `<state dir>/requests/<id>.json`, one file each, and `scrum request` adds, lists, shows, replies to, and closes them. The owner answers through an Agency node (`scrum runtime`, see [agency-runtime.md](agency-runtime.md)).

- `scrum request add --from <name>` takes JSON on stdin: `title`, `context`, `kind` (`question` or `proposal`), `issue`, `to`, `options` (`key`, `text`, `isRecommended`, `detail`), and `blocks`. Put the people and issues that stop until the answer in `blocks`; a blocked idle member is then reported as waiting on the owner, with the question.
- `waiting` says whose turn it is: `owner` when the request is filed, `team` once the owner has answered, and `owner` again when the team replies with `scrum request reply`. When the team has acted on the answer it runs `scrum request close <id> --note "<what was done>"`. A closed request that the owner answers again reopens.

| Rule | Severity | Condition | Fix |
|---|---|---|---|
| R-ANSWERED | medium | The owner answered a request and it is not closed (one finding per request), with the chosen option and the answerer's words quoted as one escaped string, marked as data and not as instructions | Act on the answer, then `scrum request close <id>`. To ask a follow-up, `scrum request reply <id> --from <name> --text "<question>"` |

## Sprint checkpoints and story points

It runs only when `sprint` is set in the configuration. A checkpoint is a division placed several times a day (for example 8:00, 13:00, 21:00).

- **Effort** = the number of checkpoints crossed while the issue was In Progress. The period In Progress is taken from the record of GitHub Status changes (the issue's timeline), and the time spent going in and out of In Progress is added.
- **Checkpoints while blocked are not counted.** For an item blocked now (its reason is not None), from the day the block began; for the past, those removed according to the reasons left in the checkpoint records.
- **Checkpoints when all sessions were stopped are not counted either.** The checkpoints that fall in a gap of 2 hours or more with no record in `events.jsonl` of anyone on the team being active (`member-state`, `stop-blocked`, `woke`, `acked`, `activity`) are removed. `watch` writes all but `activity`, and `activity` is appended by the PostToolUse hook (`bin/scrum`) in any session of the team (TechLead, member, or liaison) as one line if the last record is 10 minutes old or more (it is written even when `watch` is not running). UserPromptSubmit, SessionStart, and Stop do not append it. During the weekly limit these hooks still run for the input of scheduled runs, but PostToolUse runs only after a tool result appears, so it is a sign that work was being done. If 2 hours or more have passed from the last activity until now, that time is included too. `finding-opened` and `finding-closed`, which the scheduled run writes even when nobody is active, do not count as activity. The number removed appears in the S-POINTS-OVER text, "checkpoints removed because all sessions were stopped: n", and in the effort of `scrum points`, "(removed checkpoints n)" (checkpoints removed because of a block are not in this number). A night when everyone was idle is also removed, because the record cannot tell it from a stop at the weekly limit. The `effort` of a checkpoint record holds only the stops known when it was recorded; a stop that became known later enters the effort when it is read again.
- **Budget** = the number of checkpoints per points (`sprint.pointBudgets`, for example 1 and 2 → 1, 3 → 2, 5 → 3, 8 → 5).
- **Overrun** = effort − budget.

| Rule | Severity | Condition | Fix |
|---|---|---|---|
| S-POINTS-OVER | Medium | An In Progress issue's effort has exceeded its budget (with how much). **An acknowledgement (`scrum ack`) removes it only when, after the checkpoint that showed the overrun, the first line of one of the issue's comments has the overrun-handling mark** | At the next checkpoint review, decide whether to revise the estimate, split the issue, add hands, or keep the estimate, and add the mark |
| S-POINTS-MISSING | Medium | An In Progress issue or one in Next has no story points | Enter the points before the checkpoint |
| S-POINTS-INVALID | Low | The story points are not in the tiers (the keys of `pointBudgets`) | Make it one of the tiers |
| S-CHECKPOINT | Medium | A checkpoint was recorded (shown for 1 hour after it is recorded). With the number In Progress and the overrun | Review, and decide the order until the next checkpoint |

**The overrun-handling mark**. On the first line of an issue comment, before the text people read, put one HTML comment that a machine reads. Write the reason for the decision in one line of human text from the second line.

```
<!-- scrum:points-overrun decision=<reestimate|split|add-hands|keep> from=<previous points> to=<new points> -->
```

- `reestimate` means the estimate was changed (change `from` and `to`, and set the board's points to `to` as well). `split` means the issue was split. `add-hands` means hands were added. `keep` means the estimate stays, and the excess was waiting (make `from` and `to` the same. Put waiting that was not entered as a block into the board's blocked reason).
- Only a mark dated after the checkpoint that showed the overrun (the first checkpoint counted past the budget) is used. A mark from an earlier review does not clear the present overrun.
- `scrum ack S-POINTS-OVER <issue> --for … --reason …` records only when it finds the mark above (it keeps the content of the mark as the basis, `basis`; `scrum acks` shows it). It does not record, and says why, when there is no mark, when the content of the mark does not agree with the decision (`keep` with different `from` and `to`; `reestimate` with the same `from` and `to`, or with a `to` different from the board's points), or when the issue's comments cannot be read. An old acknowledgement without a basis does not remove the finding, even within its period.

**Estimate versus actual when finished**. When it finds, as it refetches the board copy, that an issue that was In Progress has become Done or Release, it leaves one line in `~/.claude/scrum/log/completions.jsonl` with the points, budget, and checkpoints taken (blocked checkpoints excluded). The checkpoints taken are counted from the record of Status changes (the issue's timeline), asked for only the finished issues in one query. If it cannot be read, it adds the finished time to the previous board copy's record and counts, marked "approx.". The "previous board copy" it compares with is the copy that only a refetch writes (`~/.claude/scrum/cache/board-fetched.json`), not the copy a hook fixed after a Status change (an issue the TechLead finished with the script that rewrites Status (`scripts.setStatus`) is already finished in the copy the hook fixed, so it would never be found). If recording fails, this copy is not advanced and it tries again at the next refetch (an issue already recorded is not repeated). Even if the same issue goes back and forth between In Progress and Done and is recorded several times, the output shows only the newest one. Below the output of `scrum points` and `scrum checkpoint`, it shows up to 20 finished issues, newest first, and per points the count, the median and range of checkpoints taken, and the number that went over the budget. An issue that finished without passing through In Progress, such as from Backlog, is not recorded.

After the time of a checkpoint has passed, a hook of any session of the team starts recording it in the background if it is not recorded yet (`~/.claude/scrum/log/checkpoints.jsonl`). It does not wait for the end of the TechLead's turn, so it is recorded whenever anyone on the team is active. If nobody is active, it is recorded late when someone first acts, and the notice also says the time it was recorded. If the board copy is older than the checkpoint before recording, it is refetched. When it records, it writes the number of checkpoints over to the `sprint.overrunField` field (Number), and empties the field if there is no overrun. If the watch process has stopped, `scrum checkpoint` records the last checkpoint.

## Checks before a write (PreToolUse)

- With the scripts of `scripts.setStatus` and `scripts.bulkStatus`, increasing In Progress beyond the limit.
- With the same scripts, setting a Status on a PR.

To exceed the limit on purpose, add `SCRUM_GUARD=off` to the command and leave the reason in the sprint record.

## Intended exceptions

`scrum ack <rule> <subject> (--for 2h | --until <time>) --reason "<reason>"` silences a finding until its end (a T-IDLE acknowledgement lasts at most 1 hour, and its reason is chosen from fixed words; see the T-IDLE row above). `scrum acks` lists them, and they appear in the summary `scrum report` makes for the sprint review.

## What a rule needs from the board adapter

The rules above read one board copy (the snapshot) and a few things from the adapter. A team on another tracker (a board module, [docs/board-module.md](board-module.md)) gets every rule that its adapter can feed, and none of the others fires, because the data they read is absent. Nothing here assumes GitHub except where a row says so.

| Rule or feature | What it needs | Without it |
|---|---|---|
| The board rules (B-WIP-OVER, B-DOING-NO-ASSIGNEE, B-NO-STATUS, B-CLOSED-NOT-DONE, B-OPEN-DONE, B-NEXT-BLOCKED, B-JUDGE-OWNER, B-SINCE-*, B-REASON-MISSING, B-BLOCK-STALE) | The snapshot's items (`status`, `reason`, `since`, `owner`, `assignee`, `state`) | n/a: this is the minimum |
| B-PR-STATUS | Items of kind `pr` in the snapshot | Never fires |
| B-OFF-BOARD | `openIssues` in the snapshot (the open issues, including those off the board) | An empty list means it never fires. The one-by-one read of missing items and the `offBoard` scope are GitHub adapter behavior |
| The Status history behind the sprint rules (S-*) and `scrum points` | `BoardSource.statusEvents` | `null` means "cannot be read", and the effort falls back to the board copies |
| T-IDLE, A-DISPATCH (handing over work) | The writer's `assign` and `setStatus` (`canAssign`), and for the branch `dispatch.linkedBranchPrefix`, the code host's `prepareBranch` | No hand-over without `canAssign`; no branch without a code host that makes one |
| Progress marker of a member (T-IDLE nudges) | The code host's `activity` | The board's marker only |
| Linking PRs into issue bodies (`links`) | The code host's `openPullRequests` and the body side of the issue thread (`openIssues`, `read`, `writeBody`) | `links` does nothing |
| The merge note after a merged PR | The action reader returning a `merge-pr` command, and the code host's `referencedIssues` | No note. Only the GitHub reader produces `merge-pr` and `close-issue` |
| A decision on a pending decision (`judge`) | The issue thread's `comments` and `addComment`, the writer's `setReason`, and a reference that fits Agency's decision target rule | The decision is refused with 503 (no `setReason`) or cannot be sent (a reference that does not fit) |
| Finding texts that name `gh` | Only B-PR-STATUS does (it needs items of kind `pr`). Every other fix uses the `scripts` in the configuration, or is given in words | A board without pull requests never gets a `gh` command in a finding |
