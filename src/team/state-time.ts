import { lastDates } from '../usage/summary.ts'
import type { StateMark } from './state-log.ts'
import type { ActivityState } from './types.ts'
import { baseName } from '../usage/attribution.ts'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

/** Seconds a member spent in each state on one calendar day. */
export type DayStateSeconds = { readonly date: string; readonly busySeconds: number; readonly idleSeconds: number; readonly waitingSeconds: number }

export type MemberStateSeconds = { readonly name: string; readonly byDay: readonly DayStateSeconds[] }

/**
 * What the heartbeat of a session says: when it was last seen (the end of its last interval when it is not running any more), and, when the
 * heartbeat gives them, its name and the state it has been in since a time. A session the log has no line for is counted from that state.
 */
export type SessionLife = { readonly isAlive: boolean; readonly updatedAt: string; readonly name?: string; readonly state?: ActivityState; readonly since?: string }

type Counted = 'busy' | 'waiting' | 'idle'
type Interval = { readonly from: number; readonly to: number; readonly state: Counted }
type Owned = Interval & { readonly name: string }

const dateOf = (at: number, offsetMinutes: number): string => new Date(at + offsetMinutes * MINUTE_MS).toISOString().slice(0, 10)

/** The end of a calendar day in the time zone that contains `at`. */
const dayEndAfter = (at: number, offsetMinutes: number): number => (Math.floor((at + offsetMinutes * MINUTE_MS) / DAY_MS) + 1) * DAY_MS - offsetMinutes * MINUTE_MS

/**
 * The intervals of one session. A mark lasts until the session's next mark. The last one lasts until now while the session runs, and until the
 * heartbeat's last update when it does not; a session with no heartbeat at all gets no time for it, since nothing says how long it lasted.
 */
function intervalsOf(marks: readonly StateMark[], life: SessionLife | undefined, now: number): readonly Owned[] {
  return marks.flatMap((mark, i): readonly Owned[] => {
    if (mark.state === 'ended') return []
    const from = Date.parse(mark.at)
    const next = marks[i + 1]
    const lastSeen = life === undefined ? from : life.isAlive ? now : Date.parse(life.updatedAt)
    const to = Math.min(now, next === undefined ? lastSeen : Date.parse(next.at))
    return to > from ? [{ name: mark.name, from, to, state: mark.state }] : []
  })
}

type Edge = { readonly at: number; readonly state: Counted; readonly delta: 1 | -1 }

/** What the member was doing at each moment: busy when any session is busy, else waiting for approval, else idle. Gaps with no session count for nothing. */
function segmentsOf(intervals: readonly Interval[]): readonly Interval[] {
  const edges: readonly Edge[] = intervals.flatMap((one) => [
    { at: one.from, state: one.state, delta: 1 as const },
    { at: one.to, state: one.state, delta: -1 as const },
  ])
  const sorted = edges.toSorted((a, b) => a.at - b.at)
  const open = { busy: 0, waiting: 0, idle: 0 }
  const out: Interval[] = []
  sorted.forEach((edge, i) => {
    open[edge.state] += edge.delta
    const next = sorted[i + 1]
    if (next === undefined || next.at <= edge.at) return
    const state: Counted | null = open.busy > 0 ? 'busy' : open.waiting > 0 ? 'waiting' : open.idle > 0 ? 'idle' : null
    if (state !== null) out.push({ from: edge.at, to: next.at, state })
  })
  return out
}

function addSegments(totals: Map<string, Record<Counted, number>>, segments: readonly Interval[], offsetMinutes: number): void {
  for (const segment of segments) {
    for (let at = segment.from; at < segment.to; ) {
      const end = Math.min(segment.to, dayEndAfter(at, offsetMinutes))
      const day = totals.get(dateOf(at, offsetMinutes))
      if (day !== undefined) day[segment.state] += (end - at) / 1000
      at = end
    }
  }
}

/** The state a session was in since a time, for each session whose heartbeat says so and the log has no line for (it has not changed state since the log began). */
function unlogged(marks: readonly StateMark[], sessions: ReadonlyMap<string, SessionLife>): readonly StateMark[] {
  const logged = new Set(marks.map((mark) => mark.sessionId))
  return [...sessions].flatMap(([sessionId, life]): readonly StateMark[] =>
    logged.has(sessionId) || life.name === undefined || life.state === undefined || life.since === undefined ? [] : [{ at: life.since, sessionId, name: baseName(life.name), state: life.state }],
  )
}

export type StateTimeInput = {
  readonly marks: readonly StateMark[]
  readonly sessions: ReadonlyMap<string, SessionLife>
  readonly days: number
  readonly now: Date
  /** The time zone the days are cut in, as minutes east of UTC (the same as `tokenUsage`) */
  readonly offsetMinutes: number
  /** When recording began. A state that began before it (a heartbeat file from before the log held it) is counted from then, since the time before is not known. */
  readonly recordedSince?: Date | null
}

/**
 * How long each member was busy, waiting for approval, and idle on each of the last `days` calendar days, from the hooks' state marks.
 * Time is counted only while a session is known to have run; the seconds are cut down to whole seconds, so that the three of a day never add up to more than the day.
 */
export function stateSecondsByMember({ marks, sessions, days, now, offsetMinutes, recordedSince = null }: StateTimeInput): readonly MemberStateSeconds[] {
  const dates = lastDates(days, now, offsetMinutes)
  const floor = recordedSince === null ? -Infinity : recordedSince.getTime()
  const counted = [...marks, ...unlogged(marks, sessions)].map((mark) => (Date.parse(mark.at) >= floor ? mark : { ...mark, at: new Date(floor).toISOString() }))
  const bySession = Map.groupBy(counted, (mark) => mark.sessionId)
  const owned = [...bySession].flatMap(([sessionId, own]) => intervalsOf(own, sessions.get(sessionId), now.getTime()))
  const byMember = Map.groupBy(owned, (one) => one.name)
  return [...byMember]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, intervals]) => {
      const totals = new Map(dates.map((date) => [date, { busy: 0, waiting: 0, idle: 0 }]))
      addSegments(totals, segmentsOf(intervals), offsetMinutes)
      return {
        name,
        byDay: dates.map((date) => {
          const day = totals.get(date) ?? { busy: 0, waiting: 0, idle: 0 }
          return { date, busySeconds: Math.floor(day.busy), idleSeconds: Math.floor(day.idle), waitingSeconds: Math.floor(day.waiting) }
        }),
      }
    })
}
