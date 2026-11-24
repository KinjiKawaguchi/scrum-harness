import type { SprintConfig } from '../config.ts'

const DAY_MS = 24 * 60 * 60 * 1000

function offsetMs(sprint: SprintConfig): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(sprint.utcOffset)
  if (match === null) return 0
  const minutes = Number(match[2]) * 60 + Number(match[3])
  return (match[1] === '-' ? -1 : 1) * minutes * 60_000
}

/** The date (YYYY-MM-DD) of that time at the checkpoints' offset. */
export function localDate(at: number, sprint: SprintConfig): string {
  return new Date(at + offsetMs(sprint)).toISOString().slice(0, 10)
}

/** The time of day (HH:MM) of that time at the checkpoints' offset. */
export function localClock(at: number, sprint: SprintConfig): string {
  return new Date(at + offsetMs(sprint)).toISOString().slice(11, 16)
}

function checkpointsOn(date: string, sprint: SprintConfig): readonly number[] {
  return sprint.checkpoints.map((time) => Date.parse(`${date}T${time}:00${sprint.utcOffset}`)).filter((t) => !Number.isNaN(t))
}

/** Returns the checkpoint times within the period (from, to], oldest first. */
export function checkpointsBetween(from: Date, to: Date, sprint: SprintConfig): readonly Date[] {
  const days = Math.ceil((to.getTime() - from.getTime()) / DAY_MS) + 2
  const dates = Array.from({ length: Math.max(days, 0) }, (_, i) => localDate(from.getTime() + (i - 1) * DAY_MS, sprint))
  const times = [...new Set(dates)].flatMap((date) => checkpointsOn(date, sprint))
  return times
    .filter((t) => t > from.getTime() && t <= to.getTime())
    .toSorted((a, b) => a - b)
    .map((t) => new Date(t))
}

/** The last checkpoint at or before now. */
export function latestCheckpoint(now: Date, sprint: SprintConfig): Date {
  const found = checkpointsBetween(new Date(now.getTime() - 2 * DAY_MS), now, sprint)
  return found.at(-1) ?? now
}

/** The first checkpoint after now. */
export function nextCheckpoint(now: Date, sprint: SprintConfig): Date {
  return checkpointsBetween(now, new Date(now.getTime() + 2 * DAY_MS), sprint)[0] ?? now
}
