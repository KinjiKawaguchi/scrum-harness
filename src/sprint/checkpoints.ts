import type { SprintConfig } from '../config.ts'

const DAY_MS = 24 * 60 * 60 * 1000

function offsetMs(sprint: SprintConfig): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(sprint.utcOffset)
  if (match === null) return 0
  const minutes = Number(match[2]) * 60 + Number(match[3])
  return (match[1] === '-' ? -1 : 1) * minutes * 60_000
}

/** その時刻の、節目の時差での日付 (YYYY-MM-DD)。 */
export function localDate(at: number, sprint: SprintConfig): string {
  return new Date(at + offsetMs(sprint)).toISOString().slice(0, 10)
}

/** その時刻の、節目の時差での時刻 (HH:MM)。 */
export function localClock(at: number, sprint: SprintConfig): string {
  return new Date(at + offsetMs(sprint)).toISOString().slice(11, 16)
}

function checkpointsOn(date: string, sprint: SprintConfig): readonly number[] {
  return sprint.checkpoints.map((time) => Date.parse(`${date}T${time}:00${sprint.utcOffset}`)).filter((t) => !Number.isNaN(t))
}

/** 期間 (from, to] にある節目の時刻を、古い順に返す。 */
export function checkpointsBetween(from: Date, to: Date, sprint: SprintConfig): readonly Date[] {
  const days = Math.ceil((to.getTime() - from.getTime()) / DAY_MS) + 2
  const dates = Array.from({ length: Math.max(days, 0) }, (_, i) => localDate(from.getTime() + (i - 1) * DAY_MS, sprint))
  const times = [...new Set(dates)].flatMap((date) => checkpointsOn(date, sprint))
  return times
    .filter((t) => t > from.getTime() && t <= to.getTime())
    .toSorted((a, b) => a - b)
    .map((t) => new Date(t))
}

/** 今以前の最後の節目。 */
export function latestCheckpoint(now: Date, sprint: SprintConfig): Date {
  const found = checkpointsBetween(new Date(now.getTime() - 2 * DAY_MS), now, sprint)
  return found.at(-1) ?? now
}

/** 今より後の最初の節目。 */
export function nextCheckpoint(now: Date, sprint: SprintConfig): Date {
  return checkpointsBetween(now, new Date(now.getTime() + 2 * DAY_MS), sprint)[0] ?? now
}
