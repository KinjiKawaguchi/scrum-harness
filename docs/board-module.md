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
