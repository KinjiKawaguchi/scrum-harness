# Agency runtime (agency-runtime/1)

`scrum runtime` lets an Agency node read this team and pass the owner's decisions back. It follows the specification in Agency's `docs/protocol.md` (the TeamView and agency-runtime/1 sections). This page covers only what this harness does with it.

## The command

The node runs `scrum runtime` with no further arguments and `SCRUM_STATE_DIR` set to the team's state directory. It writes **one JSON request** to stdin, and the harness writes **one JSON response** to stdout:

```
{"runtime":"agency-runtime/1","org":"acme","team":"app","op":"view"}
→ {"result": <TeamView>}                                  exit code 0
→ {"error":{"status":503,"message":"..."}}                exit code 1
```

The op (`describe`, `view`, or `decide`) is in the request. Fields the harness does not know are ignored.

| op | result |
|---|---|
| `describe` | `{"runtimes":["agency-runtime/1"],"ops":["describe","view","decide"],"label":"<team label>"}` |
| `view` | a TeamView |
| `decide` | `{}` |

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

A question or a proposal keeps its id (`r-<date>-<time>-<4 characters>`), its options (`isRecommended` is always present; `detail` only when given), its `document` (a proposal's Markdown), and `answerWith` of `{"kind":"answer","target":"<id>"}`. Once the owner has answered, it is no longer reported until the team replies and the turn returns to the owner; then `thread` carries the earlier messages, oldest first. A request that is closed is not reported.

A pending decision uses the issue's ref (`app#14`) as its id, `from` is `board`, `createdAt` is the day the block began, and `answerWith` is `{"kind":"judge","target":"app#14"}`.

Work items: `blocked.reason` is `needsDecision` for `reasonJudge`. Other reasons map through `runtime.blockedReasons` (below); a reason that is not listed is `external`. A block without a start date counts from the day the board was read. `points` appears only for whole numbers.

What the harness does not report yet: `eta` on work items, and `forecast` on epics (an epic says so in its `basis`).

## `scrum request`: questions and proposals

Agents file requests to the owner with `scrum request add --from <name>` (JSON on stdin: `title`, `context`, `kind` of `question` or `proposal`, `issue`, `to`, `options`, `blocks`; a proposal takes its Markdown body from `--document <file>` and needs two or more options). Requests are stored one file each under `<state dir>/requests/`. `scrum request list|show|reply|close` work on them. The rule R-ANSWERED, in [rules.md](rules.md), wakes the lead when the owner has answered and the team has not closed the request.

## `decide`

The node calls `decide` only after it has verified the decision.

- `kind: "answer"` answers a request in the store, by its id. The answer is a message from `owner` (with `choice` when one of the options was chosen, and the decider's id as `by`), the turn moves to the team, and R-ANSWERED reaches the lead. A closed request reopens, so a late answer still reaches the team. An unknown id is 404; a `choice` that is not an option key, or an answer with neither text nor a choice, is 400. Applying the same answer again (a retry after a lost reply) changes nothing.
- `kind: "judge"` answers an item blocked on a decision. The harness first reads the board again if its copy is older than `refreshSeconds` (this can take several seconds on a large board; the node stops a call after 20 seconds). Then:
  1. It posts a comment on the issue: a first line `<!-- agency-runtime:decision by=<person> -->`, then `Decision by <person>.`, the choice if there is one, and the text. If the same comment is already there (a retry), it does not post it again.
  2. It clears the blocked reason with the configured `scripts.setReason` script (`<number> <reasonNone>`), and updates its board copy.

  The comment comes first, so a failure in between is retried without losing the answer. `judge` needs `scripts.setReason`; without it the answer is 503. An id that is not a pending decision is 404.

## Configuration

An optional `runtime` section:

```json
"runtime": {
  "label": "App",
  "blockedReasons": { "external": "External", "waitingOnPrevious": "Waiting on previous", "timeOrEquipment": "Time or equipment" }
}
```

`label` is the team's display name (default: the team id the node sends). `blockedReasons` names the board's blocked reasons for the three kinds that are not decisions. A section of the wrong shape is ignored.

## Keeping in step with Agency

Agency's generated TypeScript types are copied unchanged to `src/agency-runtime/bindings/`, and `src/agency-runtime/types.ts` re-exports them. `test/fixtures/agency/teamview.sample.json` is Agency's shared sample. `contract/agency.lock` records the Agency commit and the hash of the types and of the sample.

- `pnpm test` checks, without the network, that the copies are the ones the lock records.
- `pnpm run check:agency` compares them with Agency's `main` (it needs `gh` and the network, so it is not part of CI) and fails when they differ. When it does, run `scripts/agency-contract.sh update` to copy the new files and the new lock, and fix whatever no longer type-checks.
- The tests also check that the sample passes the TeamView check in `src/agency-runtime/validate.ts`, that what `view` produces passes the same check and uses only keys that the sample uses. The harness runs the same check on its own output and answers 503 instead of sending a view that does not parse.
