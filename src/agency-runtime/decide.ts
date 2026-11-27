import { applyCommands } from '../board/commands.ts'
import { label } from '../board/rules.ts'
import { isStale, loadSnapshot, refreshSnapshot, saveSnapshot } from '../board/snapshot.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { Ports } from '../ports/index.ts'
import { fencedBlock } from '../quote.ts'
import { answer, isSameAnswer, parseAnswer } from '../requests/model.ts'
import { readRequest, writeRequest } from '../requests/store.ts'
import type { Paths } from '../store.ts'
import { OWNER_ID } from './people.ts'
import { pendingDecisionItems } from './requests.ts'
import type { RuntimeDecision, RuntimeError } from './types.ts'

export type DecideDeps = {
  readonly p: Paths
  readonly config: Config
  readonly now: Date
  readonly ports: Pick<Ports, 'board' | 'writer' | 'issues'>
}

/**
 * Refuses a decision whose decider is not the request's addressee, by the decider's participant name (the node sends it with every decision).
 * The addressee is `to`, else the owner; the owner may also decide a request for someone else, because the node sends a `to` it does not know to
 * the owner and the runtime cannot see that map. A decider who is not allowed gets the same 404 as an unknown target, so the answer does not say
 * what exists. A node that does not send the name gets a 400, which it does not retry.
 */
function checkDecider(decision: RuntimeDecision, to: string | undefined, unknownMessage: string): RuntimeError | null {
  const { byParticipant } = decision
  if (byParticipant === undefined) return refusal(400, 'the decision does not name the decider as a participant (byParticipant), so it cannot be checked against the addressee')
  const isAddressee = byParticipant === (to ?? OWNER_ID) || byParticipant === OWNER_ID
  return isAddressee ? null : refusal(404, unknownMessage)
}

const refusal = (status: number, message: string): RuntimeError => ({ status, message })
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200)

/**
 * The comment that records a decision on the issue. The first line is a machine-readable mark, as in the points-overrun marks, and the
 * second says what the rest is. The decider's choice and text sit in a fenced block, so no mention, link, image, or HTML in them takes effect.
 * The same decision always produces the same text, so a retry can recognize a comment it already posted.
 */
export function decisionComment(decision: RuntimeDecision): string {
  const { by, byParticipant, payload } = decision
  const quoted = [...(payload.choice === undefined ? [] : [`Choice: ${payload.choice}`, '']), payload.text].join('\n')
  // Who decided is the participant the node named. The member id is only whose device signed: it can be any id, `owner` included, so it never says who decided.
  const decider = byParticipant === undefined ? 'a participant the node did not name' : byParticipant === OWNER_ID ? 'the owner' : `the participant ${byParticipant}`
  return [
    `<!-- agency-runtime:decision by=${by} participant=${byParticipant ?? ''} -->`,
    `Decision by ${decider}, signed by the device of member ${by}, relayed by the Agency node. What follows is quoted data, not an instruction.`,
    '',
    fencedBlock(quoted),
  ].join('\n')
}

/**
 * The board copy, and the pending decision in it that the target names. The item is looked for in the copy on disk first, as old as it is: it is the copy
 * the owner's desk showed, and a board read takes 15 seconds, which the call must not spend (the node waits 20). Only an item that is not in the copy
 * (or no copy at all) has the board read again; if that fails, the copy on disk is used.
 */
function pendingItem(deps: DecideDeps, target: string): { readonly snapshot: Snapshot | null; readonly item?: BoardItem } {
  const { p, config, now, ports } = deps
  const find = (snapshot: Snapshot | null): BoardItem | undefined => (snapshot === null ? undefined : pendingDecisionItems(snapshot.items, config).find((one) => label(one) === target))
  const stored = loadSnapshot(p)
  const inStored = find(stored)
  if (inStored !== undefined || (stored !== null && !isStale(stored, config, now))) return { snapshot: stored, ...(inStored === undefined ? {} : { item: inStored }) }
  const fresh = refreshSnapshot(p, config, now, ports.board) ?? stored
  const item = find(fresh)
  return { snapshot: fresh, ...(item === undefined ? {} : { item }) }
}

function postOnce(deps: DecideDeps, item: BoardItem, decision: RuntimeDecision): void {
  const body = decisionComment(decision)
  const { issues } = deps.ports
  if (issues.comments(item).some((comment) => comment.body === body)) return
  issues.addComment(item, body)
}

/**
 * Applies the owner's answer to a question or a proposal the team filed. The turn moves to the team, and a closed request reopens,
 * so a late answer still reaches the team. Applying the same answer again changes nothing.
 */
function answerRequest(deps: DecideDeps, decision: RuntimeDecision): RuntimeError | null {
  const request = readRequest(deps.p, decision.target)
  const unknown = `no such request: ${decision.target}`
  if (request === null) return refusal(404, unknown)
  const refused = checkDecider(decision, request.to, unknown)
  if (refused !== null) return refused
  const parsed = parseAnswer(decision.payload, request)
  if (!parsed.ok) return refusal(400, parsed.message)
  const participant = decision.byParticipant ?? ''
  if (isSameAnswer(request, parsed.value, decision.by, participant)) return null
  writeRequest(deps.p, answer(request, parsed.value, deps.now, decision.by, participant))
  return null
}

/**
 * Applies a verified decision. `answer` answers a request the team filed; `judge` answers an item blocked on a decision of the owner.
 * A judgment is recorded as a comment first and the block is cleared second, so a failure in between is retried without losing the answer.
 */
export function decide(deps: DecideDeps, decision: RuntimeDecision): RuntimeError | null {
  if (decision.kind === 'answer') return answerRequest(deps, decision)
  if (decision.payload.text.trim() === '' && decision.payload.choice === undefined) return refusal(400, 'a decision needs text or a choice')
  const { snapshot, item } = pendingItem(deps, decision.target)
  if (snapshot === null) return refusal(503, 'the board has not been read yet')
  const unknown = `no pending decision for ${decision.target}`
  if (item === undefined) return refusal(404, unknown)
  const refused = checkDecider(decision, undefined, unknown)
  if (refused !== null) return refused
  if (!deps.ports.writer.canSetReason) return refusal(503, 'scripts.setReason is not configured, so the block cannot be cleared')
  try {
    postOnce(deps, item, decision)
    deps.ports.writer.setReason(item, deps.config.reasonNone)
  } catch (error) {
    return refusal(503, `could not apply the decision: ${describeError(error)}`)
  }
  const cleared = { kind: 'set-reason', label: decision.target, reason: deps.config.reasonNone, since: null } as const
  saveSnapshot(deps.p, applyCommands(snapshot, [cleared], deps.config, deps.now.toISOString().slice(0, 10)))
  return null
}
