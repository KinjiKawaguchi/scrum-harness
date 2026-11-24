import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import type { Config, SprintConfig } from '../config.ts'
import type { CountingHistory } from './counting-history.ts'
import { budgetFor, countedCheckpoints, doingIntervals } from './effort.ts'
import type { CheckpointRecord } from './record.ts'

/** For one issue: points, the budget number of checkpoints, effort (the number of checkpoints crossed), and the number exceeded. */
export type Assessment = {
  readonly label: string
  readonly points: number | null
  readonly budget: number | null
  readonly effort: number | null
  readonly over: number | null
  /** The checkpoint at which the overrun was raised (the first checkpoint counted beyond the budget. ISO 8601). null if not exceeded. Absent in records written without it */
  readonly overSince?: string | null
  /** The number of checkpoints excluded from effort because all sessions were stalled (not including those excluded because of a blocked reason). Absent if none was excluded */
  readonly teamStopped?: number
}

const isBlockedReason = (reason: string | null | undefined, config: Config): boolean =>
  reason !== null && reason !== undefined && reason !== config.reasonNone

/** If it is blocked now, checkpoints from the date the block started (0:00 at the checkpoints' offset) onward are regarded as stalled. */
function blockedNow(item: BoardItem, config: Config, sprint: SprintConfig): (at: Date) => boolean {
  if (!isBlockedReason(item.reason, config) || item.since === null) return () => false
  const from = Date.parse(`${item.since}T00:00:00${sprint.utcOffset}`)
  return (at) => at.getTime() >= from
}

/** Whether the checkpoint record says it was stalled at that checkpoint. */
function blockedInRecords(itemLabel: string, records: readonly CheckpointRecord[], config: Config): (at: Date) => boolean {
  const blocked = new Set(
    records
      .filter((record) => record.items.some((one) => one.label === itemLabel && isBlockedReason(one.reason, config)))
      .map((record) => record.scheduledFor),
  )
  return (at) => blocked.has(at.toISOString())
}

/**
 * Effort is counted from the checkpoints crossed while in In Progress, excluding the checkpoints that were stalled (those blocked by a reason, and those when all sessions were stalled).
 * The only past record looked at when counting is history.
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
