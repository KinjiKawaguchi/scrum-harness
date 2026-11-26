# Board module

A team whose issues live in another tracker can plug that tracker in without a change to this repository: the configuration names a module, kept outside the repository, that provides the board side.

```json
"adapters": { "module": "/opt/board/module.mjs", "options": { "project": "ENG" } }
```

`module` is an absolute path (or one under `~/`). `options` is JSON that the module receives as it is. A section of the wrong shape makes the whole configuration unusable, so it never falls back to the GitHub adapters (which would read another system).

## The contract (`portsVersion` 1)

The module is ES modules code that exports:

- `portsVersion`: the number `1`. Another number is refused, so a module and a harness that disagree fail at load.
- `createPorts(config, options)` (or a default export of the same shape): returns an object with any of `board`, `writer`, `actions`, `issues`, and `code`. What it leaves out stays the GitHub adapter, so a module can keep GitHub as the code host. The types are `BoardSource`, `BoardWriter`, `ActionReader`, `IssueThread`, and `CodeHost` in `src/ports/`. The action reader gets every tool call an agent makes (`actionsOf({ tool, input, response? })`: a Bash command, or an `mcp__<server>__<tool>` call, with the tool's answer after it ran), so a team whose agents write the board through MCP tools lists those tools in `hookTools`, and the module's reader turns the calls into the harness's board commands. `config` is a copy of the harness's configuration; changing it changes nothing.

What a port may leave out:

- `writer`: `addToBoard` and `setTeam` are optional (`scrum board add` and `move` then say the board cannot do it). `canAssign` and `canSetReason` are required flags that say which writes the module supports.
- `issues`: `comments` and `addComment` are required, and both take the item itself, so a tracker whose ids are not a repository and a number can serve them. `openIssues`, `read`, and `writeBody` serve one feature, linking PRs into issue bodies; give all three or none. Without them `links` does nothing.

The GitHub Project ids (`projectId`, `statusFieldId`) are required in the configuration only when no module is named. `repos` and `defaultRepo` stay required: a module's team names its own repository key there.

Each port is checked when the module is loaded: a name that is not a port (a typo), or a port without one of its functions, fails with the name.

## Trust

A module runs in the harness's process with its privileges, including in every hook. So its path comes only from the configuration, and the harness refuses a file that does not exist, is not a regular file (a link to one is fine), is not owned by the user that runs it, or can be written by the group or by others.

## References

Every item has a reference (today `<repo>#<number>`): it names the item in findings, in requests, and in the team view. A work item that waits for a decision has its reference as the target of the decision envelope, and Agency's nodes and clients accept that only as **1 to 120 bytes of ASCII letters, digits, and `.` `_` `#` `-`**. An item with another reference shows on the board but cannot be judged. So the module maps its tracker's ids into that rule (`ENG-123` is fine; `owner/repo#12`, `PROJ:12`, and a URL are not) and keeps the display text apart. The harness checks every item the module returns and fails the read, naming the item, when one does not fit.

## When the module cannot be used

A hook records the reason in `errors.log` and finishes without stopping the session. `scrum runtime` answers 503 with the reason, which the node retries. Any other command prints it and exits 1. None of them reads GitHub instead.

## Checking a module

`scrum adapter check [--module <path>] [--calls <file>]` loads the module (the one in the configuration, or the one at `--module`) and checks what can be checked without writing to the tracker. It lists every problem, not only the first one a read would stop at:

- the module loads, is trusted, and its ports have their functions;
- the snapshot its board reads: the shape of each item (`itemId`, `kind`, `repo`, `number`, `title`, `state`, the date in `since`), every Status being one the configuration names, every reference fitting the rule and being unique;
- the patterns of its action reader are valid;
- with `--calls`, what its action reader makes of tool calls. The file is a JSON list of `{ "call": { "tool", "input", "response"? }, "expect": [ ...board commands ]? }`, and a case that differs from `expect` is reported.

The writes (assign, set Status, comments) are not exercised, because they would change the tracker. The exit code is 0 when there is no problem and 1 otherwise, so a module's own tests can run it.

## A tracker program instead of a module (`scrum-board/1`)

A tracker whose owner does not want to write a module in JavaScript can give the harness a program. The harness runs it once for each call, with one JSON request on stdin, and reads one JSON answer on stdout. The program may be written in any language.

```json
"adapters": { "command": ["/opt/board/tracker", "--site", "eng"], "capabilities": ["write", "comments"], "timeoutSeconds": 30, "options": { "project": "ENG" } }
```

`command` is the program and its arguments (the first word is an absolute path, or one under `~/`). `options` is JSON that goes into every request. A section that names both a module and a command, or is of the wrong shape, makes the configuration unusable. The program is trusted like a module: a regular file of the user that runs the harness, not writable by the group or others.

### The request and the answer

Every request is an object with `board: "scrum-board/1"`, `op`, `options`, and the op's fields. The answer is `{"result": ...}`, or `{"error": {"message": "..."}}` with a non-zero exit code; a program that cannot do an op answers an error. A call that takes longer than `timeoutSeconds` is stopped. The harness never puts a request in an error message.

| op | request fields | result |
|---|---|---|
| `snapshot` | `now` (the time of the read) | `{ "fetchedAt"?: <ISO time>, "items": [...], "openIssues": [...] }`, the snapshot below |
| `statusEvents` | `items`: the references of the items | `{ "<ref>": [ { "at": <ISO time>, "status": <text or null> } ] }`, or `null` when the program cannot say |

`snapshot` is the same snapshot a board module returns (`src/board/types.ts`): each item has `itemId`, `kind` (`issue`, `pr`, or `draft`), `repo` (a project or space name), `number` (a whole number, or null), `title`, `state` (`OPEN`, `CLOSED`, `MERGED`, or null), `author`, `status`, `reason`, `since` (`YYYY-MM-DD` or null), `owner`, and `assignee`, and optionally `ref` (the reference; see References above), `points`, `labels`, and the other fields of `BoardItem`. `fetchedAt` is filled in by the harness when the program gives none. Every snapshot is checked before the harness uses it, as `scrum adapter check` does, and one that does not fit is refused with the problems named.

What else the program can do is named in `capabilities` (the configuration accepts them now; the operations behind them, and their requests, are added in the next changes, and until then only reading is offered). The harness offers, and calls, only those: `write` (assign, Status, blocked reason, overrun), `add` (add an issue to the board), `team` (hand an item to a team), `comments` (read and add comments). Without a capability the matching operation is not available, and what needs it (for example a decision on a pending item, which needs `comments` and `write`) says so. The agents' own board writes are read from the `scripts` named in the configuration, as for GitHub. Everything the program does not provide stays GitHub.

`scrum adapter check` works for a program too: it calls `snapshot` and lists every problem in what it answers.
