import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import type { Config, SprintConfig } from '../config.ts'
import type { CountingHistory } from './counting-history.ts'
import { budgetFor, countedCheckpoints, doingIntervals } from './effort.ts'
import type { CheckpointRecord } from './record.ts'

/** 1件の issue の、ポイント・目安の節目の数・手間 (またいだ節目の数)・超えた数。 */
export type Assessment = {
  readonly label: string
  readonly points: number | null
  readonly budget: number | null
  readonly effort: number | null
  readonly over: number | null
  /** 超過を出した節目 (目安を超えて数えた最初の節目。ISO 8601)。超えていなければ null。古い記録には無い */
  readonly overSince?: string | null
  /** 全セッションが止まっていて、手間から除いた節目の数 (理由で止まっていて除いた分は含まない)。1 つも除かなければ無い */
  readonly teamStopped?: number
}

const isBlockedReason = (reason: string | null | undefined, config: Config): boolean =>
  reason !== null && reason !== undefined && reason !== config.reasonNone

/** 今止まっているなら、止まり始めた日 (節目の時差での 0 時) からの節目は止まっていたとみなす。 */
function blockedNow(item: BoardItem, config: Config, sprint: SprintConfig): (at: Date) => boolean {
  if (!isBlockedReason(item.reason, config) || item.since === null) return () => false
  const from = Date.parse(`${item.since}T00:00:00${sprint.utcOffset}`)
  return (at) => at.getTime() >= from
}

/** 節目の記録に、その節目で止まっていたと残っているか。 */
function blockedInRecords(itemLabel: string, records: readonly CheckpointRecord[], config: Config): (at: Date) => boolean {
  const blocked = new Set(
    records
      .filter((record) => record.items.some((one) => one.label === itemLabel && isBlockedReason(one.reason, config)))
      .map((record) => record.scheduledFor),
  )
  return (at) => blocked.has(at.toISOString())
}

/**
 * 手間は、作業中にまたいだ節目から、止まっていた節目 (理由で止まっていたもの、全セッションが止まっていたもの) を除いて数える。
 * 数えるときに見る過去の記録は、history だけ。
 */
export function assessItem(item: BoardItem, history: CountingHistory, config: Config, now: Date): Assessment {
  const itemLabel = label(item)
  const points = item.points ?? null
  const sprint = config.sprint
  if (sprint === undefined) return { label: itemLabel, points, budget: null, effort: null, over: null }
  const budget = budgetFor(points, sprint)
  if (item.statusEvents === undefined) return { label: itemLabel, points, budget, effort: null, over: null }
  const isNowBlocked = blockedNow(item, config, sprint)
  const isRecordedBlocked = blockedInRecords(itemLabel, history.records, config)
  const intervals = doingIntervals(item.statusEvents, config.statuses.doing, now)
  const isBlocked = (at: Date) => isNowBlocked(at) || isRecordedBlocked(at)
  const counted = countedCheckpoints(intervals, sprint, (at) => isBlocked(at) || history.teamStop(at))
  const teamStopped = countedCheckpoints(intervals, sprint, isBlocked).length - counted.length
  const effort = counted.length
  const over = budget === null ? null : Math.max(0, effort - budget)
  const overSince = budget === null || effort <= budget ? null : (counted[budget]?.toISOString() ?? null)
  return { label: itemLabel, points, budget, effort, over, overSince, ...(teamStopped > 0 ? { teamStopped } : {}) }
}
