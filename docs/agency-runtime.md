# Agency runtime (agency-runtime/1)

`scrum runtime` lets an Agency node read this team and pass the owner's decisions back. It follows the specification in Agency's `docs/protocol.md` (the TeamView and agency-runtime/1 sections). This page covers only what this harness does with it.

## The command

The node runs `scrum runtime` with no further arguments and `SCRUM_STATE_DIR` set to the team's state directory. It writes **one JSON request** to stdin, and the harness writes **one JSON response** to stdout:

```
{"runtime":"agency-runtime/1","org":"acme","team":"app","op":"view"}
→ {"result": <TeamView>}                                  exit code 0
→ {"error":{"status":503,"message":"..."}}                exit code 1
```

The op (`describe`, `view`, `decide`, or the optional `tokenUsage` and `activity`) is in the request. Fields the harness does not know are ignored.

| op | result |
|---|---|
| `describe` | `{"runtimes":["agency-runtime/1"],"ops":["describe","view","decide","tokenUsage","activity"],"label":"<team label>"}` |
| `view` | a TeamView |
| `decide` | `{}` |
| `tokenUsage` | a TokenUsage (below) |
| `activity` | an Activity (below) |

Errors use the specification's statuses: 400 for malformed input (not JSON, wrong runtime version, unknown op, an id that is not an id, a decision without text or a choice), 404 for a target that does not exist or is not waiting for a decision, and 503 when the harness cannot act now (not configured, no board read yet, a script or `gh` failed). The node does not retry 400 and 404.

## What `view` reports

`view` reads the board copy that the harness already keeps and the session records. It never waits for the board: if the copy is older than `refreshSeconds` it starts a background refresh and answers from the copy; if there is no copy yet it starts a refresh and answers 503. `generatedAt` is the time the board was read, so a client can tell that a quiet harness is stale.

| TeamView | From |
|---|---|
| `people` | The lead (`techlead`), the `members`, and the owner. |
| `requests` | The questions and proposals the team filed that wait for the owner (`scrum request`, below), then one `pendingDecision` for each open issue whose blocked reason is `reasonJudge`. |
| `work` | Open issues whose status is one of the configured `statuses`, without parents of other items, issues by `excludeAuthors`, and closed items. |
| `epics` | Items that other items name as their parent, while a child is unfinished (finished means `release` or `done`). Parents are read only when `dispatch` or `alerts` is enabled. |

People:

| Session state | `state` | `waitingOn` | `status` |
|---|---|---|---|
| busy | `working` | none | `Working on app#12` (or `Working`) |
| waiting for a permission prompt | `working` | the owner | `Permission prompt: waiting for approval` |
| idle | `idle` | the lead, once idle for `idleMinutes` (members only) | `Idle for 30 minutes; nothing in Next` |
| no live session | `away` | none | `No live session` |

The owner is `owner`, a human, with state `unknown` and a one-line count of waiting requests. A person is named by the harness's own name (the session name), and `holding` lists the unfinished open items assigned to them. An idle member named in a request's `blocks` is reported as waiting on the owner, with the question in `status`. A request without `to` goes to the owner.

A question or a proposal keeps its id (`r-<date>-<time>-<4 characters>`), its options (`isRecommended` is always present; `detail` only when given), its `document` (a proposal's Markdown), and `answerWith` of `{"kind":"answer","target":"<id>"}`. The owner's words appear in a thread as `owner` only when they came through a verified `decide`, which records the decider's id. `scrum request add` and `reply` refuse the names `owner`, `board`, and `unverified` for `--from`, and a stored message that claims to be the owner's without a recorded decider is reported as `unverified`. Once the owner has answered, it is no longer reported until the team replies and the turn returns to the owner; then `thread` carries the earlier messages, oldest first. A request that is closed is not reported.

A pending decision uses the issue's ref (`app#14`) as its id, `from` is `board`, `createdAt` is the day the block began, and `answerWith` is `{"kind":"judge","target":"app#14"}`.

Work items: `blocked.reason` is `needsDecision` for `reasonJudge`. Other reasons map through `runtime.blockedReasons` (below); a reason that is not listed is `external`. A block without a start date counts from the day the board was read. `points` appears only for whole numbers.

What the harness does not report yet: `eta` on work items, and `forecast` on epics (an epic says so in its `basis`).

## `scrum request`: questions and proposals

Agents file requests to the owner with `scrum request add --from <name>` (JSON on stdin: `title`, `context`, `kind` of `question` or `proposal`, `issue`, `to`, `options`, `blocks`; a proposal takes its Markdown body from `--document <file>` and needs two or more options). Requests are stored one file each under `<state dir>/requests/`. `scrum request list|show|reply|close` work on them. The rule R-ANSWERED, in [rules.md](rules.md), wakes the lead when the owner has answered and the team has not closed the request.

## `decide`

The node calls `decide` only after it has verified the decision. The harness checks the decider again, by `byParticipant` (the decider's name in this team, which the node sends with every decision, in the same name space as a request's `to`). A decision is applied only when `byParticipant` is the request's addressee (`to`, else `owner`) or `owner`: the owner may decide a request for someone else, because the node sends a `to` it does not know to the owner and the runtime cannot see that map. A pending decision has no `to`, so a `judge` is applied only from `owner`. Any other decider gets the same 404 as an unknown target and nothing is recorded. A decision without `byParticipant` (a node that does not send it) is refused with 400, which the node does not retry. This needs no configuration.

- `kind: "answer"` answers a request in the store, by its id. The answer is a message from `owner` (with `choice` when one of the options was chosen, and the decider's id as `by`), the turn moves to the team, and R-ANSWERED reaches the lead. A closed request reopens, so a late answer still reaches the team. An unknown id is 404; a `choice` that is not an option key, or an answer with neither text nor a choice, is 400. Applying the same answer again (a retry after a lost reply) changes nothing.
- `kind: "judge"` answers an item blocked on a decision. The harness first reads the board again if its copy is older than `refreshSeconds` (this can take several seconds on a large board; the node stops a call after 20 seconds). Then:
  1. It posts a comment on the issue: a first line `<!-- agency-runtime:decision by=<person> -->`, then a line saying the rest is quoted data relayed by the node, then the choice (if there is one) and the text inside a fenced block, so no mention, link, image, or HTML in it takes effect. If the same comment is already there (a retry), it does not post it again.
  2. It clears the blocked reason with the configured `scripts.setReason` script (`<number> <reasonNone>`), and updates its board copy.

  The comment comes first, so a failure in between is retried without losing the answer. `judge` needs `scripts.setReason`; without it the answer is 503. An id that is not a pending decision is 404.

## `tokenUsage`: token use by day and person

`{"runtime":"agency-runtime/1","org":"acme","team":"app","op":"tokenUsage","days":14}` (`days` is a whole number from 1 to 90) returns

```
{"result":{"org":"acme","team":"app","days":14,"generatedAt":"<time>",
  "byDay":[{"date":"2026-11-24","costUsd":{"TechLead":1.25,"SWE1":3.1}}],
  "byPerson":[{"person":"SWE1","costUsd":9.8,"tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}
```

- `byDay` has one entry for each of the last `days` calendar days, oldest first and today last. A day with no usage has an empty `costUsd`. The days are cut in the time zone of `runtime.utcOffset`, else `sprint.utcOffset`, else UTC.
- `byPerson` lists the people with usage in that window, most expensive first. `cacheWrite` adds the 5-minute and the 1-hour cache writes.
- People are the lead and the members, named as in the TeamView. The liaison and sessions outside the team are not counted.
- Costs are an estimate: the tokens priced as if billed by the API (USD, rounded to cents), not a subscription bill. The one price table is `src/usage/pricing.ts`.
- 404 means no session of the team has recorded usage. 503 means the first read of the transcripts has not finished.

The numbers come from the agents' Claude Code transcripts, read through the `TranscriptSource` port (`src/ports/usage.ts`; the adapter is `src/adapters/claude-code/`). Reading the first time can take minutes, so the call never waits for it: when the index (`<state dir>/cache/usage-index.json`) is missing or older than 5 minutes, `tokenUsage` starts `scrum usage-index` in the background and answers from what the index holds. The index remembers how far each transcript was read, counts every response once, and only the projects that hold a session of the team are read. To count again from scratch, delete the index.

## `activity`: what the team did

`{"runtime":"agency-runtime/1","org":"acme","team":"app","op":"activity","since":"2026-11-24T12:00:00Z","limit":100}` (`since` is a time in UTC ending in Z; `limit` is a whole number from 1 to 500) returns

```
{"result":{"org":"acme","team":"app","generatedAt":"<time>","truncated":false,
  "events":[{"id":"b-3f2a9c01d4e7","at":"2026-11-24T12:03:10Z","kind":"itemAdded","ref":"app#41","title":"...","epic":"app#40"}]}}
```

- `events` are oldest first, and every `at` is strictly after `since` (so ask again with `since` one second before the last `at` you saw, and drop what you already have by `id`). `truncated` is true when `limit` cut the list: ask again from the last `at`.
- `id` is stable and unique in the team: the same event always has the same id. Board events have `b-...`, messages `m-...`.
- The kinds, and their fields (optional ones are left out, never null):
  - `itemAdded`: `ref`, `title`, `epic?`. An issue or a task was added to the board.
  - `statusChanged`: `ref`, `title`, `from`, `to` (a WorkStatus as in the TeamView), `epic?`.
  - `prOpened`: `ref` (the pull request), `title`, `by?` (only when the PR's author is a participant's name), `issue?`, `epic?`.
  - `prMerged`: the same, and `leadSeconds?` (opened to merged).
  - `message`: `from` (a participant's name), `to` (a plain name), `summary` (at most 120 characters). It is the short label the sender gave the message, empty when it gave none, and never taken from the body.
- **Messages** come from the team's transcripts, read by the same reader that builds the token usage (`scrum usage-index`, which `view`, `tokenUsage`, and `activity` start in the background). For each `SendMessage` call of a team session it takes the recipient (`to`), the summary the sender gave the call, the call's id, and the time of the line, and nothing else: the message itself (`message`, `content`) is never read, kept, or sent. `from` is the session's name (a second session that took a name counts as the member). A subagent's messages, a session outside the team, a recipient that is not a plain name (a socket address, a path), and a message to oneself are left out. Only what the reader reads from now on is in the log: earlier messages are not (the index of the transcripts does not go back).
- The log keeps the last 24 hours (`cache/activity.jsonl` in the state directory). A `since` older than that answers what the log has. The call only reads the log, so it is as cheap as `view`; it starts the board refresh and the transcript reader in the background when they are due, as `view` and `tokenUsage` do. An empty list means nothing happened, or the log has not been filled yet (`generatedAt` says when the answer was made).
- **Board events** are written by the board refresh (`scrum refresh`, which the watch, the scheduler, and `view` and `activity` start when the copy is stale). `itemAdded` is at the time the item was added to the board; `prOpened` and `prMerged` are at the pull request's own times, for pull requests that are items of the board, and `leadSeconds` is the difference; `issue` is the first issue the pull request closes (`Closes #N`). `statusChanged` is at the time the refresh first saw the new Status, so it can be late by one refresh interval (5 minutes by default). `epic` is the item's parent: the harness reads parents only when `runtime.activity` is true (or `dispatch` or `alerts` is on), because it adds a field to every issue the board read asks for, which an older GitHub Enterprise Server may not have. A title is cut at 200 characters.

## Configuration

An optional `runtime` section:

```json
"runtime": {
  "label": "App",
  "utcOffset": "+09:00",
  "blockedReasons": { "external": "External", "waitingOnPrevious": "Waiting on previous", "timeOrEquipment": "Time or equipment" }
}
```

`label` is the team's display name (default: the team id the node sends). `activity` (true or false, default false) makes the board read ask for each issue's parent, so the events of `activity` carry their `epic`. `utcOffset` is the time zone `tokenUsage` cuts days in. `blockedReasons` names the board's blocked reasons for the three kinds that are not decisions. A section of the wrong shape is ignored.

## Keeping in step with Agency

Agency's generated TypeScript types are copied unchanged to `src/agency-runtime/bindings/`, and `src/agency-runtime/types.ts` re-exports them. `test/fixtures/agency/teamview.sample.json` is Agency's shared sample. `contract/agency.lock` records the Agency commit and the hash of the types and of the sample.

- `pnpm test` checks, without the network, that the copies are the ones the lock records.
- `pnpm run check:agency` compares them with Agency's `main` (it needs `gh` and the network, so it is not part of CI) and fails when they differ. When it does, run `scripts/agency-contract.sh update` to copy the new files and the new lock, and fix whatever no longer type-checks.
- The tests also check that the sample passes the TeamView check in `src/agency-runtime/validate.ts`, that what `view` produces passes the same check and uses only keys that the sample uses. The harness runs the same check on its own output and answers 503 instead of sending a view that does not parse.
