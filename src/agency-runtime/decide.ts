import { applyCommands } from '../board/commands.ts'
import { label } from '../board/rules.ts'
import { isStale, loadSnapshot, refreshSnapshot, saveSnapshot } from '../board/snapshot.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { Ports } from '../ports/index.ts'
import type { Paths } from '../store.ts'
import { pendingDecisionItems } from './requests.ts'
import type { RuntimeDecision, RuntimeError } from './types.ts'

export type DecideDeps = {
  readonly p: Paths
  readonly config: Config
  readonly now: Date
  readonly ports: Pick<Ports, 'board' | 'writer' | 'issues'>
}

const refusal = (status: number, message: string): RuntimeError => ({ status, message })
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200)

/**
 * The comment that records a decision on the issue. The first line is a machine-readable mark, as in the points-overrun marks.
 * The same decision always produces the same text, so a retry can recognize a comment it already posted.
 */
export function decisionComment(decision: RuntimeDecision): string {
  const { by, payload } = decision
  const lines = [`<!-- agency-runtime:decision by=${by} -->`, `Decision by ${by}.`, ...(payload.choice === undefined ? [] : [`Choice: ${payload.choice}`]), '', payload.text]
  return lines.join('\n')
}

/** The board as of now. A stale copy is read again; if that fails, the copy on disk is used. */
function currentSnapshot(deps: DecideDeps): Snapshot | null {
  const { p, config, now, ports } = deps
  const stored = loadSnapshot(p)
  if (!isStale(stored, config, now)) return stored
  return refreshSnapshot(p, config, now, ports.board) ?? stored
}

function postOnce(deps: DecideDeps, item: BoardItem, decision: RuntimeDecision): void {
  const body = decisionComment(decision)
  const { issues } = deps.ports
  if (issues.comments(item).some((comment) => comment.body === body)) return
  issues.addComment(item.repo, item.number as number, body)
}

/**
 * Applies a verified decision. Only `judge` exists here: an item blocked on a decision of the owner.
 * The decision is recorded as a comment first and the block is cleared second, so a failure in between is retried without losing the answer.
 */
export function decide(deps: DecideDeps, decision: RuntimeDecision): RuntimeError | null {
  if (decision.kind === 'answer') return refusal(404, `no such request: ${decision.target}`)
  if (decision.payload.text.trim() === '' && decision.payload.choice === undefined) return refusal(400, 'a decision needs text or a choice')
  const snapshot = currentSnapshot(deps)
  if (snapshot === null) return refusal(503, 'the board has not been read yet')
  const item = pendingDecisionItems(snapshot.items, deps.config).find((one) => label(one) === decision.target)
  if (item === undefined) return refusal(404, `no pending decision for ${decision.target}`)
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
