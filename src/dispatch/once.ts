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
 * 待機の外から、部下に 1 回だけ、選んで渡す。待機プロセスは、部下の Stop と SessionStart でしか始まらないので、
 * dispatch を有効にした時にすでに空いている部下は、次の Stop まで渡されない。その部下を、1 回だけ動かす手。
 * ボードの書き換え (担当と Status) は、待機プロセスと同じ道 (dispatchStep) で行う。部下のセッションを起こすことは、ここではできないので、
 * 返した文面を、呼んだ人が、その部下のセッションに送る。names を渡せばその人だけ、無ければ渡す相手の全員を見る。
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

/** 結果を、呼んだ人が読む形にする。送る文面には、送り先を付ける。 */
export function formatOnce(results: readonly OnceResult[]): string {
  const sent = results.filter((result) => result.outcome !== null)
  const lines = results.map((result) => (result.outcome === null ? `${result.member}: not sending (${result.reason})` : `${result.member}: sending (${result.outcome.record.kind === 'nudge' ? 'nudge' : 'handed over'} ${result.outcome.record.label})`))
  const messages = sent.flatMap((result) => ['', `--- send this text to ${result.member}'s session with SendMessage ---`, result.outcome?.message ?? ''])
  return [...lines, ...messages, ...(sent.length === 0 ? ['', 'nothing to send'] : [])].join('\n')
}
