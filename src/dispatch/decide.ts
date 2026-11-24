import { label } from '../board/rules.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { MemberState } from '../team/types.ts'
import { chooseNext, ownDoingIssue, type Tier } from './choose.ts'
import { boardOnly, hasProgress, seenKey, type ProgressToken, type SeenMap, type TokenOf } from './progress.ts'
import type { DispatchRecord } from './types.ts'

/** The upper limit on the number of nudges sent while the work does not progress. If it does not progress that many times in a row, the TechLead is told (A-NUDGE-IGNORED). */
export const NUDGE_LIMIT = 2

/** The recent span over which nudges are counted. Nudges older than this are not counted (after a long time has passed, counting restarts). */
export const NUDGE_WINDOW_MS = 3 * 60 * 60_000

export type Action =
  | { readonly kind: 'nudge'; readonly item: BoardItem; readonly count: number; readonly token: ProgressToken }
  | { readonly kind: 'dispatch'; readonly item: BoardItem; readonly tier: Tier }
  | { readonly kind: 'none'; readonly reason: 'nudge-wait' | 'nudge-limit' | 'wip-limit' | 'no-candidate' | 'already-dispatched' }
  /** The work is progressing (idleMinutes have not passed since the marker last changed), so no nudge. item and token are for remembering the marker seen */
  | { readonly kind: 'none'; readonly reason: 'progressing'; readonly item: BoardItem; readonly token: ProgressToken }

/** The nudges to that person for that issue that are within the most recent NUDGE_WINDOW_MS. Oldest first. */
export function nudgesFor(records: readonly DispatchRecord[], member: string, issue: string, now: Date): readonly DispatchRecord[] {
  return records
    .filter((record) => record.kind === 'nudge' && record.member === member && record.label === issue && now.getTime() - Date.parse(record.at) <= NUDGE_WINDOW_MS)
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/**
 * The number of nudges, counting back from the latest in a row, after which the work did not progress. For each nudge, that nudge's marker is compared with the next nudge's marker (for the last nudge, the current marker).
 * Counting does not restart even if the free span changes (even if the member returns to free after one short turn). On a nudge after which the work progressed, the count up to that point stops.
 */
export function ignoredNudges(nudges: readonly DispatchRecord[], current: ProgressToken | undefined): number {
  const count = nudges.reduceRight((state, nudge, index) => {
    if (state.isStopped) return state
    const next = index === nudges.length - 1 ? current : nudges[index + 1]?.progress
    return hasProgress(nudge.progress, next) ? { count: state.count, isStopped: true } : { count: state.count + 1, isStopped: false }
  }, { count: 0, isStopped: false })
  return count.count
}

function lastDispatchAt(records: readonly DispatchRecord[], name: string): number {
  return Math.max(0, ...records.filter((record) => record.member === name && record.kind !== 'nudge').map((record) => Date.parse(record.at)))
}

function lastSendAt(records: readonly DispatchRecord[], name: string): number {
  return Math.max(lastDispatchAt(records, name), ...records.filter((record) => record.member === name && record.kind === 'nudge').map((record) => Date.parse(record.at)))
}

/**
 * Decides what to send to a member who is free and has no acknowledgement (one who passed idleGate).
 * If they have their own In Progress issue that is not blocked, no new issue is handed over, and they are nudged to advance it. Every idleMinutes since the last send,
 * up to NUDGE_LIMIT times while the work does not progress (counting restarts if it progresses; whether it progressed is compared by the marker at the time of the nudge and the issue's current marker). A repeat nudge right after a handover waits.
 * No nudge while the work is progressing: if the marker changed from the one seen before (it progressed), or idleMinutes have not passed since the marker last changed, it waits (progressing) ahead of the nudge limit.
 * If the In Progress issue is blocked, or there is none, the next issue is handed over.
 */
export function decideAction(
  snapshot: Snapshot,
  member: MemberState,
  records: readonly DispatchRecord[],
  config: Config,
  now: Date,
  tokenOf: TokenOf = boardOnly,
  seen: SeenMap = {},
): Action {
  const own = ownDoingIssue(snapshot, member.name, config)
  if (own !== null) {
    if (now.getTime() - lastSendAt(records, member.name) < config.idleMinutes * 60_000) return { kind: 'none', reason: 'nudge-wait' }
    const token = tokenOf(own)
    const lastSeen = seen[seenKey(member.name, label(own))]
    const isProgressing = lastSeen !== undefined && (hasProgress(lastSeen.token, token) || now.getTime() - Date.parse(lastSeen.at) < config.idleMinutes * 60_000)
    if (isProgressing) return { kind: 'none', reason: 'progressing', item: own, token }
    const ignored = ignoredNudges(nudgesFor(records, member.name, label(own), now), token)
    if (ignored >= NUDGE_LIMIT) return { kind: 'none', reason: 'nudge-limit' }
    return { kind: 'nudge', item: own, count: ignored + 1, token }
  }
  if (member.since !== null && lastDispatchAt(records, member.name) >= Date.parse(member.since)) return { kind: 'none', reason: 'already-dispatched' }
  const chosen = chooseNext(snapshot, member.name, config)
  return chosen.kind === 'chosen' ? { kind: 'dispatch', item: chosen.item, tier: chosen.tier } : chosen
}
