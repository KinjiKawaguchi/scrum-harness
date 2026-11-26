import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { readText } from '../store.ts'
import type { ActivityEvent } from './types.ts'

/** How long the log keeps events. A `since` older than this answers what the log has. */
export const RETENTION_MS = 24 * 60 * 60 * 1000

/** When the file holds more lines than this, it is rewritten with only what is still kept. */
const TRIM_LINES = 5000

/** A stable id: the prefix says where it came from, and the same parts always give the same id, so an event seen twice is one event. */
export function eventId(prefix: 'b' | 'm', ...parts: readonly string[]): string {
  return `${prefix}-${createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 12)}`
}

const isEvent = (value: unknown): value is ActivityEvent =>
  typeof value === 'object' && value !== null && typeof (value as ActivityEvent).id === 'string' && typeof (value as ActivityEvent).kind === 'string' && !Number.isNaN(Date.parse((value as ActivityEvent).at))

/** The events in the log, oldest first, once each (the first of an id wins). A line that cannot be read is dropped. */
export function readEvents(path: string): readonly ActivityEvent[] {
  const seen = new Set<string>()
  const events = readText(path)
    .split('\n')
    .flatMap((line): readonly ActivityEvent[] => {
      try {
        const value: unknown = JSON.parse(line)
        return isEvent(value) && !seen.has(value.id) ? [(seen.add(value.id), value)] : []
      } catch {
        return []
      }
    })
  return events.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
}

/** Appends events that are inside the retention window. An event older than the window is dropped, as are events whose id is already there. */
export function appendEvents(path: string, events: readonly ActivityEvent[], now: Date): number {
  const cutoff = now.getTime() - RETENTION_MS
  const known = new Set(readEvents(path).map((one) => one.id))
  const fresh = events.filter((one) => Date.parse(one.at) > cutoff && !known.has(one.id))
  const unique = [...new Map(fresh.map((one) => [one.id, one])).values()]
  if (unique.length === 0) return 0
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, unique.map((one) => `${JSON.stringify(one)}\n`).join(''))
  return unique.length
}

/** Rewrites the log with only the events still kept, when it has grown. Safe to skip: reading ignores what is too old. */
export function trimLog(path: string, now: Date): void {
  const lines = readText(path).split('\n').filter((line) => line !== '')
  if (lines.length <= TRIM_LINES) return
  const kept = readEvents(path).filter((one) => Date.parse(one.at) > now.getTime() - RETENTION_MS)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, kept.map((one) => `${JSON.stringify(one)}\n`).join(''))
  renameSync(tmp, path)
}

/** The first `limit` events strictly after `since`, oldest first, and whether more remain. */
export function eventsSince(events: readonly ActivityEvent[], since: Date, limit: number, now: Date): { readonly events: readonly ActivityEvent[]; readonly truncated: boolean } {
  const floor = Math.max(since.getTime(), now.getTime() - RETENTION_MS)
  const after = events.filter((one) => Date.parse(one.at) > floor)
  return { events: after.slice(0, limit), truncated: after.length > limit }
}
