import { existsSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { baseName } from '../usage/attribution.ts'
import { appendLine, readText } from '../store.ts'
import type { ActivityState } from './types.ts'

/** How long the log is kept. It matches the longest range `tokenUsage` answers. */
export const STATE_LOG_DAYS = 90

/** One session entering a state, at the time its hook saw it. A state lasts until the session's next mark. */
export type StateMark = { readonly at: string; readonly sessionId: string; readonly name: string; readonly state: ActivityState }

const STATES: readonly string[] = ['busy', 'idle', 'waiting', 'ended']

function isMark(value: unknown): value is StateMark {
  if (typeof value !== 'object' || value === null) return false
  const mark = value as Partial<StateMark>
  return typeof mark.sessionId === 'string' && typeof mark.name === 'string' && typeof mark.state === 'string' && STATES.includes(mark.state) && typeof mark.at === 'string' && !Number.isNaN(Date.parse(mark.at))
}

/** Where the time recording began is kept, next to the log. */
const startPathOf = (path: string): string => path.replace(/\.jsonl$/, '.since')

/**
 * When recording began in this state directory: what the marker beside the log says, else, for a log that began before the marker was kept, when the
 * log file was made. Null when nothing has been recorded. A line may say a state began earlier than this (a heartbeat file from before the log held it);
 * the time before it is not recorded and is not counted.
 */
export function recordingStart(path: string): Date | null {
  const kept = Date.parse(readText(startPathOf(path)).trim())
  if (!Number.isNaN(kept)) return new Date(kept)
  try {
    const { birthtimeMs, mtimeMs } = statSync(path)
    return new Date(birthtimeMs > 0 ? birthtimeMs : mtimeMs)
  } catch {
    return null
  }
}

export function appendStateMark(path: string, mark: StateMark): void {
  const marker = startPathOf(path)
  if (!existsSync(marker)) {
    // The first line of a log that already exists keeps the time the log was made; the first line of a new log, now.
    const start = recordingStart(path) ?? new Date()
    try {
      writeFileSync(marker, `${start.toISOString()}\n`, { flag: 'wx' })
    } catch {
      // another hook wrote it first
    }
  }
  appendLine(path, JSON.stringify({ at: mark.at, sessionId: mark.sessionId, name: baseName(mark.name), state: mark.state }))
}

/** The marks in the file, oldest first. A line that cannot be read is dropped. */
export function readStateMarks(path: string): readonly StateMark[] {
  const marks = readText(path)
    .split('\n')
    .flatMap((line): readonly StateMark[] => {
      try {
        const value: unknown = JSON.parse(line)
        return isMark(value) ? [value] : []
      } catch {
        return []
      }
    })
  return marks.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/**
 * The marks that are still needed: everything inside the retention window, and, for each session, the last mark before it, since that one says
 * what the session was doing when the window began.
 */
export function keptMarks(marks: readonly StateMark[], now: Date): readonly StateMark[] {
  const cutoff = now.getTime() - STATE_LOG_DAYS * 86_400_000
  const lastBefore = new Map<string, StateMark>()
  for (const mark of marks) if (Date.parse(mark.at) <= cutoff) lastBefore.set(mark.sessionId, mark)
  const inside = marks.filter((mark) => Date.parse(mark.at) > cutoff)
  return [...lastBefore.values(), ...inside].toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/** Rewrites the log without what is no longer needed, when something can go. Safe to skip: reading ignores what is out of range. */
export function trimStateLog(path: string, now: Date): void {
  const marks = readStateMarks(path)
  const kept = keptMarks(marks, now)
  if (kept.length === marks.length) return
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, kept.map((mark) => `${JSON.stringify(mark)}\n`).join(''))
  renameSync(tmp, path)
}
