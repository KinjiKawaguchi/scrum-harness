import type { Config } from '../config.ts'
import { dispatchOf } from '../config.ts'
import { loadContext } from '../findings/lint.ts'
import type { Paths } from '../store.ts'
import { decideAction } from './decide.ts'
import { idleGate } from './due.ts'
import { defaultProbe, readSeen, tokenWith, type ProgressProbe } from './progress.ts'
import { dispatchStep, type DispatchOutcome, type Exec } from './run.ts'

export type OnceResult = { readonly member: string; readonly outcome: DispatchOutcome | null; readonly reason: string }

const GATE_REASON: Readonly<Record<string, string>> = {
  disabled: 'dispatch.enabled が true でない',
  'not-target': '渡す相手に入っていない',
  'not-idle': '空きではない',
  'too-short': '空きが idleMinutes に届いていない',
  accepted: '有効な T-IDLE の受け入れがある',
}

const ACTION_REASON: Readonly<Record<string, string>> = {
  'nudge-wait': '促しの間隔の待ち (最後に送ってから idleMinutes 経っていない)',
  'nudge-limit': '作業が進まないまま促しを上限まで送った (A-NUDGE-IGNORED で TechLead に出る)',
  progressing: '作業が進んでいる (最後に印が変わってから idleMinutes たっていない)',
  'wip-limit': '作業中が上限に届いている',
  'no-candidate': '渡せる issue が無い (Q-EMPTY の対象)',
  'already-dispatched': '渡した後に、まだ動いていない',
}

/**
 * 待機の外から、部下に 1 回だけ、選んで渡す。待機プロセスは、部下の Stop と SessionStart でしか始まらないので、
 * dispatch を有効にした時にすでに空いている部下は、次の Stop まで渡されない。その部下を、1 回だけ動かす手。
 * ボードの書き換え (担当と Status) は、待機プロセスと同じ道 (dispatchStep) で行う。部下のセッションを起こすことは、ここではできないので、
 * 返した文面を、呼んだ人が、その部下のセッションに送る。names を渡せばその人だけ、無ければ渡す相手の全員を見る。
 */
export function dispatchOnce(p: Paths, config: Config, now: Date, exec: Exec, names: readonly string[] = [], probe: ProgressProbe = defaultProbe): readonly OnceResult[] {
  const dispatch = dispatchOf(config)
  const targets = names.length > 0 ? names : (dispatch.members ?? config.members)
  return targets.map((member): OnceResult => {
    const outcome = dispatchStep(p, config, member, now, exec, probe)
    if (outcome !== null) return { member, outcome, reason: '' }
    const ctx = loadContext(p, config, now)
    const state = ctx.members.find((one) => one.name === member)
    if (state === undefined) return { member, outcome: null, reason: 'セッションの稼働を読めない (チームの外の名前か、心拍が無い)' }
    const gate = idleGate(state, ctx.acks, config, now)
    if (!gate.isDue) return { member, outcome: null, reason: GATE_REASON[gate.reason] ?? gate.reason }
    if (ctx.snapshot === null) return { member, outcome: null, reason: 'ボードの控えが無い' }
    const action = decideAction(ctx.snapshot, state, ctx.dispatches ?? [], config, now, tokenWith(probe), readSeen(p))
    return { member, outcome: null, reason: action.kind === 'none' ? (ACTION_REASON[action.reason] ?? action.reason) : '書き込みの守り (作業中の上限) か、失敗の後の待ち (5 分) で止まった' }
  })
}

/** 結果を、呼んだ人が読む形にする。送る文面には、送り先を付ける。 */
export function formatOnce(results: readonly OnceResult[]): string {
  const sent = results.filter((result) => result.outcome !== null)
  const lines = results.map((result) => (result.outcome === null ? `${result.member}: 送らない (${result.reason})` : `${result.member}: 送る (${result.outcome.record.kind === 'nudge' ? '促し' : '渡した'} ${result.outcome.record.label})`))
  const messages = sent.flatMap((result) => ['', `--- ${result.member} のセッションに、次の文を SendMessage で送る ---`, result.outcome?.message ?? ''])
  return [...lines, ...messages, ...(sent.length === 0 ? ['', '送る文は無い'] : [])].join('\n')
}
