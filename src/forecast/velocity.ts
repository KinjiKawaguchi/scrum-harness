import { workStatusOf } from '../agency-runtime/work.ts'
import { isEpic, label } from '../board/rules.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { doingIntervals, type StatusEvent } from '../sprint/effort.ts'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** The window the velocity is measured over. */
export const VELOCITY_DAYS = 7
/** Fewer finished issues than this is not a week of history. */
export const MIN_SAMPLES = 3
/** An issue that was In Progress for less than this has no real working time to measure (it was moved through the column). */
const MIN_HOURS = 0.25
/** The most finished issues whose Status changes are read. */
export const MAX_CANDIDATES = 60

export type Velocity =
  | {
      readonly kind: 'measured'
      /** Points finished for each hour an issue was In Progress (that is, for each member-hour, as one member works on an issue) */
      readonly pointsPerHour: number
      /** The quarter of the issues that went slowest and the quarter that went fastest (the lowest and highest when there are fewer than four) */
      readonly low: number
      readonly high: number
      readonly samples: number
      readonly points: number
      readonly hours: number
      /** Finished issues with points that could not be used, and why */
      readonly skipped: readonly string[]
    }
  | { readonly kind: 'missing'; readonly why: string }

const isFinishedStatus = (item: BoardItem, config: Config): boolean => {
  const status = workStatusOf(item, config)
  return item.kind === 'issue' && (status === 'done' || status === 'release')
}

/** The finished issues with points whose Status changes are worth reading: those that finished in the window, most recent first, and at most MAX_CANDIDATES. */
export function finishedCandidates(snapshot: Snapshot, config: Config, now: Date): readonly BoardItem[] {
  const since = now.getTime() - VELOCITY_DAYS * DAY_MS
  return snapshot.items
    .filter((item) => isFinishedStatus(item, config) && typeof item.points === 'number' && !config.excludeAuthors.includes(item.author ?? '') && !isEpic(item, snapshot.items))
    // an issue in Release is not closed yet, and it has no time to filter by: its Status changes say when it finished
    .filter((item) => item.closedAt === undefined || Date.parse(item.closedAt) >= since)
    .toSorted((a, b) => Date.parse(b.closedAt ?? now.toISOString()) - Date.parse(a.closedAt ?? now.toISOString()))
    .slice(0, MAX_CANDIDATES)
}

/** When an issue reached Done or Release, from its Status changes: the last such change. */
function finishedAt(events: readonly StatusEvent[], config: Config): number | null {
  const times = events.filter((one) => one.status === config.statuses.done || one.status === config.statuses.release).map((one) => Date.parse(one.at))
  return times.length === 0 ? null : Math.max(...times)
}

/** The value a fraction q of the way through the sorted values, between the two it falls between. */
function quantile(sorted: readonly number[], q: number): number {
  const at = q * (sorted.length - 1)
  const below = Math.floor(at)
  const lower = sorted[below] ?? 0
  return lower + ((sorted[Math.min(sorted.length - 1, below + 1)] ?? lower) - lower) * (at - below)
}

/**
 * How fast this team turns points into finished work: the points of the issues that finished in the last 7 days over the hours they were In Progress, from
 * their Status changes. Missing, with the reason, when there are fewer than three such issues or their Status changes could not be read: no number is made up.
 */
export function measureVelocity(candidates: readonly BoardItem[], events: ReadonlyMap<string, readonly StatusEvent[]> | null, config: Config, now: Date): Velocity {
  if (events === null) return { kind: 'missing', why: 'the Status changes of the finished issues could not be read' }
  const since = now.getTime() - VELOCITY_DAYS * DAY_MS
  const skipped: string[] = []
  const samples = candidates.flatMap((item) => {
    const list = events.get(label(item))
    if (list === undefined) return (skipped.push(`${label(item)} (its Status changes were not read)`), [])
    const end = finishedAt(list, config)
    if (end === null || end < since) return []
    const hours = doingIntervals(list, config.statuses.doing, now).reduce((sum, one) => sum + (one.end - one.start) / HOUR_MS, 0)
    if (hours < MIN_HOURS) return (skipped.push(`${label(item)} (In Progress for under ${MIN_HOURS * 60} minutes)`), [])
    return [{ points: item.points as number, hours }]
  })
  if (samples.length < MIN_SAMPLES) return { kind: 'missing', why: `${samples.length} issue${samples.length === 1 ? '' : 's'} with points finished in the last ${VELOCITY_DAYS} days with a measurable time In Progress; ${MIN_SAMPLES} are needed` }
  const points = samples.reduce((sum, one) => sum + one.points, 0)
  const hours = samples.reduce((sum, one) => sum + one.hours, 0)
  const rates = samples.filter((one) => one.points > 0).map((one) => one.points / one.hours).toSorted((a, b) => a - b)
  const low = rates.length < 4 ? (rates[0] ?? 0) : quantile(rates, 0.25)
  const high = rates.length < 4 ? (rates.at(-1) ?? 0) : quantile(rates, 0.75)
  return { kind: 'measured', pointsPerHour: points / hours, low, high, samples: samples.length, points, hours, skipped }
}

export type MergeRate = { readonly merged: number; readonly perDay: number; readonly perHour: number }

/** The pull requests merged in the last 7 days, when the board's pull requests carry their merge time; null when none does (it is not read). */
export function mergeRate(snapshot: Snapshot, now: Date): MergeRate | null {
  const prs = snapshot.items.filter((item) => item.kind === 'pr')
  if (!prs.some((item) => item.mergedAt !== undefined || item.openedAt !== undefined)) return null
  const since = now.getTime() - VELOCITY_DAYS * DAY_MS
  const merged = prs.filter((item) => item.mergedAt !== undefined && Date.parse(item.mergedAt) >= since).length
  return { merged, perDay: merged / VELOCITY_DAYS, perHour: merged / (VELOCITY_DAYS * 24) }
}
