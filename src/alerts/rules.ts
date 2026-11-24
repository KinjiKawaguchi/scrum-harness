import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { DispatchRecord } from '../dispatch/types.ts'
import type { Ack } from '../findings/acks.ts'
import type { MemberState } from '../team/types.ts'
import { alertsOf } from './config.ts'
import { emptyChoices } from './empty.ts'
import { evaluateEmpty } from './empty-findings.ts'
import { epicViews } from './epic.ts'
import { evaluateEpicStalls } from './epic-findings.ts'
import type { AlertEvaluation, AlertState } from './types.ts'

export type AlertInput = {
  readonly snapshot: Snapshot | null
  /** TechLead と部下の稼働 */
  readonly members: readonly MemberState[]
  readonly acks: readonly Ack[]
  readonly dispatches: readonly DispatchRecord[]
  readonly alerts: AlertState
  readonly config: Config
  readonly now: Date
}

const NOTHING: AlertEvaluation = { findings: [], owner: [] }

/**
 * 止まりの検知 (E-STALL: 動く人のいない Epic、Q-EMPTY: 渡せる issue が無い部下)。TechLead への指摘と、
 * オーナーへの通知を、同じ材料から作る。最初に見た時刻は alerts (待機プロセスが書く状態) から読む。
 */
export function evaluateAlerts(input: AlertInput): AlertEvaluation {
  const { snapshot, members, acks, dispatches, alerts, config, now } = input
  if (!alertsOf(config).enabled || snapshot === null) return NOTHING
  const stalls = evaluateEpicStalls(epicViews(snapshot, members, config), alerts.epics, config, now)
  const empties = evaluateEmpty(emptyChoices(snapshot, members, acks, dispatches, config, now), alerts.empty, config, now)
  return { findings: [...stalls.findings, ...empties.findings], owner: [...stalls.owner, ...empties.owner] }
}
