import type { SprintConfig } from '../config.ts'
import { checkpointsBetween } from './checkpoints.ts'

/** Status の変化の記録 (GitHub の issue の timeline から)。 */
export type StatusEvent = { readonly at: string; readonly status: string | null }

export type Interval = { readonly start: number; readonly end: number }

/** 作業中にいた期間を、出入りした回数だけ返す。今も作業中なら今で閉じる。 */
export function doingIntervals(events: readonly StatusEvent[], doing: string, now: Date): readonly Interval[] {
  const sorted = events.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const { intervals, openedAt } = sorted.reduce<{ readonly intervals: readonly Interval[]; readonly openedAt: number | null }>(
    (acc, event) => {
      const at = Date.parse(event.at)
      if (event.status === doing) return acc.openedAt === null ? { ...acc, openedAt: at } : acc
      if (acc.openedAt === null) return acc
      return { intervals: [...acc.intervals, { start: acc.openedAt, end: at }], openedAt: null }
    },
    { intervals: [], openedAt: null },
  )
  return openedAt === null ? intervals : [...intervals, { start: openedAt, end: now.getTime() }]
}

/** 作業中の期間にまたいだ節目 (止まっていた節目は除く)。古い順。 */
export function countedCheckpoints(
  intervals: readonly Interval[],
  sprint: SprintConfig,
  isBlockedAt: (checkpoint: Date) => boolean,
): readonly Date[] {
  return intervals
    .flatMap((interval) => checkpointsBetween(new Date(interval.start), new Date(interval.end), sprint))
    .filter((checkpoint) => !isBlockedAt(checkpoint))
    .toSorted((a, b) => a.getTime() - b.getTime())
}

/** 作業中の期間にまたいだ節目の数。止まっていた節目は数えない。 */
export function countEffort(
  intervals: readonly Interval[],
  sprint: SprintConfig,
  isBlockedAt: (checkpoint: Date) => boolean,
): number {
  return countedCheckpoints(intervals, sprint, isBlockedAt).length
}

/** ポイントから決めた目安の節目の数。段に無いポイントは null。 */
export function budgetFor(points: number | null, sprint: SprintConfig): number | null {
  if (points === null) return null
  return sprint.pointBudgets[String(points)] ?? null
}
