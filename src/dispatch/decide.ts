import { label } from '../board/rules.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { MemberState } from '../team/types.ts'
import { chooseNext, ownDoingIssue, type Tier } from './choose.ts'
import { boardOnly, hasProgress, seenKey, type ProgressToken, type SeenMap, type TokenOf } from './progress.ts'
import type { DispatchRecord } from './types.ts'

/** 作業が進まないまま促しを送った回数の上限。これだけ続けて進まなければ、TechLead に出す (A-NUDGE-IGNORED)。 */
export const NUDGE_LIMIT = 2

/** 促しを数える、直近の長さ。これより前の促しは数えない (長く経った後は、数え直す)。 */
export const NUDGE_WINDOW_MS = 3 * 60 * 60_000

export type Action =
  | { readonly kind: 'nudge'; readonly item: BoardItem; readonly count: number; readonly token: ProgressToken }
  | { readonly kind: 'dispatch'; readonly item: BoardItem; readonly tier: Tier }
  | { readonly kind: 'none'; readonly reason: 'nudge-wait' | 'nudge-limit' | 'wip-limit' | 'no-candidate' | 'already-dispatched' }
  /** 作業が進んでいる (最後に印が変わってから idleMinutes たっていない) ので、促さない。item と token は、見た印を覚えるため */
  | { readonly kind: 'none'; readonly reason: 'progressing'; readonly item: BoardItem; readonly token: ProgressToken }

/** その人のその issue への促しで、直近 NUDGE_WINDOW_MS の中のもの。古い順。 */
export function nudgesFor(records: readonly DispatchRecord[], member: string, issue: string, now: Date): readonly DispatchRecord[] {
  return records
    .filter((record) => record.kind === 'nudge' && record.member === member && record.label === issue && now.getTime() - Date.parse(record.at) <= NUDGE_WINDOW_MS)
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/**
 * 促しのうち、後ろから続けて、作業が進まなかったものの数。促しごとに、その促しの印と、次の促しの印 (最後の促しは、いまの印) を比べる。
 * 空きの区間が変わっても (短い 1 ターンで空きに戻っても) 数え直さない。作業が進んだ促しで、そこまでの数は止まる。
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
 * 空いて、受け入れも無い部下 (idleGate を通った人) に、何を送るかを決める。
 * 止まっていない自分の作業中の issue があれば、新しい issue は渡さず、それを進めるよう促す。最後に送ってから idleMinutes ごとに、
 * 作業が進まないまま NUDGE_LIMIT 回まで (進めば数え直す。進んだかは、促した時点と今の issue の印で比べる)。渡した直後の重ねての促しは待つ。
 * 作業が進んでいる間は促さない: 前に見た印から変わった (進んだ) か、最後に印が変わってから idleMinutes たっていなければ、促しの上限より先に、待つ (progressing)。
 * 作業中が止まっているか、無ければ、次の issue を渡す。
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
