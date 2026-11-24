import type { Config } from '../config.ts'
import { dispatchOf } from '../config.ts'
import { loadContext } from '../findings/lint.ts'
import type { Paths } from '../store.ts'
import { decideAction } from './decide.ts'
import { idleGate } from './due.ts'
import { readSeen, tokenWith } from './progress.ts'
import { dispatchStep, type DispatchOutcome, type DispatchPorts } from './run.ts'

export type OnceResult = { readonly member: string; readonly outcome: DispatchOutcome | null; readonly reason: string }

const GATE_REASON: Readonly<Record<string, string>> = {
  disabled: 'dispatch.enabled is not true',
  'not-target': 'not among the members handed work',
  'not-idle': 'not idle',
  'too-short': 'idle for less than idleMinutes',
  accepted: 'a valid T-IDLE acknowledgement exists',
}

const ACTION_REASON: Readonly<Record<string, string>> = {
  'nudge-wait': 'waiting out the nudge interval (idleMinutes have not passed since the last one)',
  'nudge-limit': 'nudged up to the limit with no progress (shown to the TechLead as A-NUDGE-IGNORED)',
  progressing: 'work is progressing (idleMinutes have not passed since the marker last changed)',
  'wip-limit': 'In Progress is at the limit',
  'no-candidate': 'no issue to hand over (subject to Q-EMPTY)',
  'already-dispatched': 'has not moved since the last hand-over',
}

/**
 * Selects and hands over to a member exactly once, from outside the watch. The watch process starts only at a member's Stop and SessionStart,
 * so a member who is already free when dispatch is enabled is not handed anything until the next Stop. This is the means of moving that member exactly once.
 * The board rewrite (assignee and Status) goes through the same path as the watch process (dispatchStep). It cannot wake the member's session here, so
 * the caller sends the returned text to that member's session. If names is given, only those people; if absent, everyone among those who receive handovers is looked at.
 */
export function dispatchOnce(p: Paths, config: Config, now: Date, ports: DispatchPorts, names: readonly string[] = []): readonly OnceResult[] {
  const dispatch = dispatchOf(config)
  const targets = names.length > 0 ? names : (dispatch.members ?? config.members)
  return targets.map((member): OnceResult => {
    const outcome = dispatchStep(p, config, member, now, ports)
    if (outcome !== null) return { member, outcome, reason: '' }
    const ctx = loadContext(p, config, now, ports.sessions)
    const state = ctx.members.find((one) => one.name === member)
    if (state === undefined) return { member, outcome: null, reason: 'cannot read the session activity (a name outside the team, or no heartbeat)' }
    const gate = idleGate(state, ctx.acks, config, now)
    if (!gate.isDue) return { member, outcome: null, reason: GATE_REASON[gate.reason] ?? gate.reason }
    if (ctx.snapshot === null) return { member, outcome: null, reason: 'no board copy' }
    const action = decideAction(ctx.snapshot, state, ctx.dispatches ?? [], config, now, tokenWith(ports.code.activity), readSeen(p))
    return { member, outcome: null, reason: action.kind === 'none' ? (ACTION_REASON[action.reason] ?? action.reason) : 'stopped by the write guard (In Progress limit) or by the wait after a failure (5 minutes)' }
  })
}

/** Turns the result into a form the caller reads. The text to send is given its destination. */
export function formatOnce(results: readonly OnceResult[]): string {
  const sent = results.filter((result) => result.outcome !== null)
  const lines = results.map((result) => (result.outcome === null ? `${result.member}: not sending (${result.reason})` : `${result.member}: sending (${result.outcome.record.kind === 'nudge' ? 'nudge' : 'handed over'} ${result.outcome.record.label})`))
  const messages = sent.flatMap((result) => ['', `--- send this text to ${result.member}'s session with SendMessage ---`, result.outcome?.message ?? ''])
  return [...lines, ...messages, ...(sent.length === 0 ? ['', 'nothing to send'] : [])].join('\n')
}
