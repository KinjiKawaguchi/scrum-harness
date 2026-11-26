import { lintBoard } from '../board/rules.ts'
import { loadSnapshot } from '../board/snapshot.ts'
import type { Snapshot } from '../board/types.ts'
import { teamNamesOf, type Config } from '../config.ts'
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
import { readMemberSources, type MemberSource } from '../members/funding.ts'
import { lintRefusedStarts, lintStartFailures } from '../members/rules.ts'
import { readStartFailures, type StartFailure } from '../members/start-failures.ts'
import { readRequests } from '../requests/store.ts'
import type { OwnerRequest } from '../requests/types.ts'
import { applyAcks, type Ack } from './acks.ts'
import { bySeverity, makeFinding, type Finding } from './types.ts'

export type LintContext = {
  readonly snapshot: Snapshot | null
  /** Activity of the TechLead and the members */
  readonly members: readonly MemberState[]
  readonly acks: readonly Ack[]
  readonly config: Config
  readonly now: Date
  /** Past records used when counting effort (the checkpoint records and the time when all sessions were stalled). If absent, no checkpoint is excluded */
  readonly history?: CountingHistory
  /** The record of work handed to free members */
  readonly dispatches?: readonly DispatchRecord[]
  /** The time first seen, remembered by stall detection */
  readonly alerts?: AlertState
  /** The work markers the watch process last saw, per member and per issue (so that A-NUDGE-IGNORED compares with the same marker as the nudge decision) */
  readonly seen?: SeenMap
  /** Requests to the owner. One the owner answered and the team has not closed becomes R-ANSWERED. */
  readonly requests?: readonly OwnerRequest[]
  /** Members that were started and showed no sign of life (M-START-FAILED) */
  readonly startFailures?: readonly StartFailure[]
  /** The account each member started on, or why its start was refused (M-SOURCE-REFUSED) */
  readonly memberSources?: readonly MemberSource[]
}

export type LintResult = { readonly active: readonly Finding[]; readonly acked: readonly Finding[] }

const EMPTY: Snapshot = { fetchedAt: new Date(0).toISOString(), items: [], openIssues: [] }

/** A board copy as stale as after 3 failed re-fetches in a row. Tells the TechLead that the findings are being shown at that staleness. */
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
    ...lintStartFailures(ctx.startFailures ?? [], ctx.members),
    ...lintRefusedStarts(ctx.memberSources ?? [], ctx.members),
  ]
  // A T-IDLE acknowledgement that does not pass the check at creation (at most 1 hour, a fixed reason) does not silence the finding
  const { active, acked } = applyAcks(findings, ctx.acks.filter((ack) => isValidIdleAck(ack, ctx.config)), ctx.now)
  return { active: active.toSorted(bySeverity), acked }
}

/** Combines the hook heartbeat and the session records. A member without a heartbeat is also known to be free. */
export function collectSignals(p: Paths, now: Date, sessions: SessionDirectory): readonly SessionSignal[] {
  return [...sessions.signals(), ...readHeartbeats(p, now)]
}

export function loadContext(p: Paths, config: Config, now: Date, sessions: SessionDirectory, snapshot?: Snapshot | null): LintContext {
  const names = teamNamesOf(config)
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
    startFailures: readStartFailures(p.startFailures),
    memberSources: readMemberSources(p.memberSources),
  }
}
