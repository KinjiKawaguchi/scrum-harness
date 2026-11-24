import type { SprintConfig } from '../config.ts'
import { checkpointsBetween } from './checkpoints.ts'

/** The Status change record (from the GitHub issue's timeline). */
export type StatusEvent = { readonly at: string; readonly status: string | null }

export type Interval = { readonly start: number; readonly end: number }

/** Returns the periods spent in In Progress, one per entry and exit. If it is still In Progress, the period is closed at now. */
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

/** The checkpoints crossed during the In Progress periods (excluding stalled checkpoints). Oldest first. */
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

/** The number of checkpoints crossed during the In Progress periods. Stalled checkpoints are not counted. */
export function countEffort(
  intervals: readonly Interval[],
  sprint: SprintConfig,
  isBlockedAt: (checkpoint: Date) => boolean,
): number {
  return countedCheckpoints(intervals, sprint, isBlockedAt).length
}

/** The budget number of checkpoints decided from the points. null for points not in the tiers. */
export function budgetFor(points: number | null, sprint: SprintConfig): number | null {
  if (points === null) return null
  return sprint.pointBudgets[String(points)] ?? null
}
