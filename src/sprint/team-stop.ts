import { readText, type Paths } from '../store.ts'
import type { Interval } from './effort.ts'

/** If the activity record has a gap this long, all sessions are regarded as having been stalled during it (2 hours). */
export const TEAM_STOP_MS = 2 * 60 * 60 * 1000

/**
 * The kinds of records that show someone on the team moved. member-state, stop-blocked, woke, and acked are written by watch, and activity is written by
 * the team sessions' hook (bin/scrum) once every 10 minutes even when watch is not running.
 * The opening and closing of findings (finding-opened, finding-closed), which the scheduled run writes even when nobody is moving, are not counted as activity.
 */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set(['member-state', 'stop-blocked', 'woke', 'acked', 'activity'])

/** Whether all sessions were stalled at that time. */
export type TeamStop = (at: Date) => boolean

export const NEVER_STOPPED: TeamStop = () => false

function activityTime(line: string): readonly number[] {
  try {
    const record = JSON.parse(line) as { readonly at?: unknown; readonly type?: unknown }
    if (typeof record.type !== 'string' || !ACTIVITY_TYPES.has(record.type) || typeof record.at !== 'string') return []
    const at = Date.parse(record.at)
    return Number.isNaN(at) ? [] : [at]
  } catch {
    return []
  }
}

/** From the text of events.jsonl, returns the times (milliseconds) of the activity records, oldest first. Unreadable lines and kinds that are not activity are dropped. */
export function activityTimes(text: string): readonly number[] {
  return text
    .split('\n')
    .flatMap(activityTime)
    .toSorted((a, b) => a - b)
}

/**
 * The periods in which the activity record had a gap of at least minimum. The span from the last activity to now is included too if it is at least minimum.
 * If there is not a single activity record, nothing can be said, so empty is returned.
 */
export function stoppedSpans(times: readonly number[], now: Date, minimum: number = TEAM_STOP_MS): readonly Interval[] {
  const edges = [...times, now.getTime()]
  return edges.slice(1).flatMap((end, index): readonly Interval[] => {
    const start = edges[index] ?? end
    return end - start >= minimum ? [{ start, end }] : []
  })
}

/** A time that lies inside one of the stalled periods (endpoints not included) is regarded as stalled. */
export function teamStopFrom(spans: readonly Interval[]): TeamStop {
  return (at) => spans.some((span) => span.start < at.getTime() && at.getTime() < span.end)
}

/** From ~/.claude/scrum/log/events.jsonl, builds the periods in which all sessions were stalled. */
export function loadTeamStop(p: Paths, now: Date): TeamStop {
  return teamStopFrom(stoppedSpans(activityTimes(readText(p.events)), now))
}
