import { lintBoard } from '../board/rules.ts'
import { loadSnapshot } from '../board/snapshot.ts'
import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { SessionDirectory } from '../ports/index.ts'
import { readJson, type Paths } from '../store.ts'
import { readHeartbeats } from '../team/heartbeat.ts'
import { lintTeam } from '../team/rules.ts'
import { aggregateMembers } from '../team/state.ts'
import type { MemberState, SessionSignal } from '../team/types.ts'
import { EMPTY_HISTORY, loadCountingHistory, type CountingHistory } from '../sprint/counting-history.ts'
import { lintSprint } from '../sprint/rules.ts'
import { evaluateAlerts } from '../alerts/rules.ts'
import { readAlertState } from '../alerts/state.ts'
import { EMPTY_ALERT_STATE, type AlertState } from '../alerts/types.ts'
import { readDispatches } from '../dispatch/records.ts'
import { readSeen, type SeenMap } from '../dispatch/progress.ts'
import { lintDispatch } from '../dispatch/rules.ts'
import type { DispatchRecord } from '../dispatch/types.ts'
import { currentRuleName } from '../compat.ts'
import { isValidIdleAck } from '../dispatch/idle-ack.ts'
import { lintRequests } from '../requests/rules.ts'
import { readRequests } from '../requests/store.ts'
import type { OwnerRequest } from '../requests/types.ts'
import { applyAcks, type Ack } from './acks.ts'
import { bySeverity, makeFinding, type Finding } from './types.ts'

export type LintContext = {
  readonly snapshot: Snapshot | null
  /** TechLead と部下の稼働 */
  readonly members: readonly MemberState[]
  readonly acks: readonly Ack[]
  readonly config: Config
  readonly now: Date
  /** 手間を数えるときの過去の記録 (節目の記録と、全セッションが止まっていた時間)。無ければ、どの節目も除かない */
  readonly history?: CountingHistory
  /** 空いた部下に渡した仕事の記録 */
  readonly dispatches?: readonly DispatchRecord[]
  /** 止まりの検知が覚えている、最初に見た時刻 */
  readonly alerts?: AlertState
  /** 待機プロセスが最後に見た、部下ごと、issue ごとの作業の印 (A-NUDGE-IGNORED が、促しの判断と同じ印で比べるため) */
  readonly seen?: SeenMap
  /** Requests to the owner. One the owner answered and the team has not closed becomes R-ANSWERED. */
  readonly requests?: readonly OwnerRequest[]
}

export type LintResult = { readonly active: readonly Finding[]; readonly acked: readonly Finding[] }

const EMPTY: Snapshot = { fetchedAt: new Date(0).toISOString(), items: [], openIssues: [] }

/** 取り直しが3回続けて失敗したくらい古い控え。指摘がその古さのまま出ていることを TechLead に伝える。 */
const STALE_FACTOR = 3

function lintFreshness(snapshot: Snapshot | null, config: Config, now: Date): readonly Finding[] {
  if (snapshot === null) return []
  const minutes = Math.floor((now.getTime() - Date.parse(snapshot.fetchedAt)) / 60_000)
  if (minutes * 60 <= config.refreshSeconds * STALE_FACTOR) return []
  return [
    makeFinding({
      rule: 'B-SNAPSHOT-STALE',
      subject: 'board',
      severity: 'medium',
      message: `The board copy is still from ${minutes} minutes ago. A failing refresh is suspected. The board findings are as of then`,
      fix: 'See errors.log and fetch-failed-* in ~/.claude/scrum/log/',
    }),
  ]
}

export function lintAll(ctx: LintContext): LintResult {
  const snapshot = ctx.snapshot ?? EMPTY
  const subordinates = ctx.members.filter((member) => ctx.config.members.includes(member.name))
  const findings = [
    ...lintFreshness(ctx.snapshot, ctx.config, ctx.now),
    ...lintBoard(snapshot, ctx.config, ctx.now),
    ...lintTeam(subordinates, snapshot, ctx.config, ctx.now),
    ...lintSprint(snapshot, ctx.history ?? EMPTY_HISTORY, ctx.config, ctx.now),
    ...lintDispatch(ctx.dispatches ?? [], ctx.config, ctx.now, subordinates, ctx.snapshot, ctx.seen ?? {}),
    ...evaluateAlerts({ ...ctx, dispatches: ctx.dispatches ?? [], alerts: ctx.alerts ?? EMPTY_ALERT_STATE }).findings,
    ...lintRequests(ctx.requests ?? [], ctx.config),
  ]
  // 作るときの検査 (最長 1 時間、決まった理由) を通らない T-IDLE の受け入れは、指摘を黙らせない
  const { active, acked } = applyAcks(findings, ctx.acks.filter((ack) => isValidIdleAck(ack, ctx.config)), ctx.now)
  return { active: active.toSorted(bySeverity), acked }
}

/** フックの心拍とセッションの記録を合わせる。心拍が無い部下も、空いていることが分かる。 */
export function collectSignals(p: Paths, now: Date, sessions: SessionDirectory): readonly SessionSignal[] {
  return [...sessions.signals(), ...readHeartbeats(p, now)]
}

export function loadContext(p: Paths, config: Config, now: Date, sessions: SessionDirectory, snapshot?: Snapshot | null): LintContext {
  const names = [config.techlead, ...config.members]
  return {
    snapshot: snapshot === undefined ? loadSnapshot(p) : snapshot,
    members: aggregateMembers(collectSignals(p, now, sessions), names),
    acks: readJson<readonly Ack[]>(p.acks, []).map((ack) => ({ ...ack, rule: currentRuleName(ack.rule) })),
    config,
    now,
    history: config.sprint === undefined ? EMPTY_HISTORY : loadCountingHistory(p, now),
    dispatches: readDispatches(p),
    alerts: readAlertState(p),
    seen: readSeen(p),
    requests: readRequests(p),
  }
}
