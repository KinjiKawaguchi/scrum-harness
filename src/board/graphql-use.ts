import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readJson, releaseLock, tryLock } from '../store.ts'

/**
 * What the harness spends of the account's GraphQL points, and when it holds back. Every team on a machine runs its own processes, so both are kept in the
 * directory the teams share (board/shared.ts: `SCRUM_SHARED_DIR`), one file each, and read from there by every team.
 */

/** One GraphQL call of the harness: when, which team, what it asked, and the points it cost (a call that does not say what it cost is a small query, and counts as `SMALL_QUERY_POINTS`). */
export type UseEntry = { readonly at: string; readonly team: string; readonly what: string; readonly points: number }

const HOUR_MS = 60 * 60_000

/**
 * What a call that does not state its cost is counted as. The tracker charges a small query a fraction of a point (measured against its own counter: 40 trivial
 * queries and 30 `issue list` calls moved it by 11 and 8), though its answer says a cost of 1, so counting them as 1 each made the sum larger than the account's own.
 */
export const SMALL_QUERY_POINTS = 0.25

/** A ledger is cut down to its last two hours when it grows past this many bytes. */
const MOST_LEDGER_BYTES = 256 * 1024

export const useLedgerPath = (directory: string): string => join(directory, 'graphql-use.jsonl')
export const backoffPath = (directory: string): string => join(directory, 'github-backoff.json')

const isEntry = (value: unknown): value is UseEntry => {
  const entry = value as Partial<UseEntry> | null
  return typeof entry === 'object' && entry !== null && typeof entry.at === 'string' && typeof entry.team === 'string' && typeof entry.what === 'string' && typeof entry.points === 'number'
}

/** Every entry the ledger holds, oldest first. A line that is not an entry is left out. */
export function readUse(directory: string): readonly UseEntry[] {
  try {
    return readFileSync(useLedgerPath(directory), 'utf8').split('\n').flatMap((line): UseEntry[] => {
      try {
        const value: unknown = JSON.parse(line)
        return isEntry(value) ? [value] : []
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

/** Drops what is older than two hours, so the file does not grow without end. Skipped while another process is doing it. */
function trimUse(directory: string, now: Date): void {
  const path = useLedgerPath(directory)
  const lock = `${path}.lock`
  if (!tryLock(lock)) return
  try {
    const cut = now.getTime() - 2 * HOUR_MS
    const kept = readUse(directory).filter((entry) => Date.parse(entry.at) >= cut)
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    releaseLock(lock)
  }
}

/** Adds a call to the ledger. Never throws: not being able to count must not stop the work. */
export function recordUse(directory: string, entry: UseEntry, now: Date): void {
  try {
    const path = useLedgerPath(directory)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    if (statSync(path).size > MOST_LEDGER_BYTES) trimUse(directory, now)
  } catch {
    // The count is a help, not a part of the work.
  }
}

/** What the harness spent in the hour up to `now`: the points, the calls, and the most expensive kinds of call. */
export type UseSummary = {
  readonly points: number
  readonly calls: number
  readonly byWhat: readonly { readonly what: string; readonly points: number; readonly calls: number }[]
  readonly byTeam: readonly { readonly team: string; readonly points: number }[]
}

export function summarizeUse(entries: readonly UseEntry[], now: Date): UseSummary {
  const since = now.getTime() - HOUR_MS
  const recent = entries.filter((entry) => Date.parse(entry.at) > since && Date.parse(entry.at) <= now.getTime())
  const group = <K extends string>(key: (entry: UseEntry) => K): ReadonlyMap<K, { points: number; calls: number }> =>
    recent.reduce((acc, entry) => {
      const sum = acc.get(key(entry)) ?? { points: 0, calls: 0 }
      return new Map([...acc, [key(entry), { points: sum.points + entry.points, calls: sum.calls + 1 }]])
    }, new Map<K, { points: number; calls: number }>())
  const byPoints = <T extends { points: number }>(a: T, b: T): number => b.points - a.points
  return {
    points: recent.reduce((sum, entry) => sum + entry.points, 0),
    calls: recent.length,
    byWhat: [...group((entry) => entry.what)].map(([what, sum]) => ({ what, ...sum })).toSorted(byPoints),
    byTeam: [...group((entry) => entry.team)].map(([team, sum]) => ({ team, points: sum.points })).toSorted(byPoints),
  }
}

/** Why and until when the harness does not ask GitHub's GraphQL. `streak` counts the limits in a row, so the wait grows while it goes on. */
export type Backoff = { readonly until: string; readonly reason: string; readonly streak: number }

export function readBackoff(directory: string): Backoff | null {
  const value = readJson<Partial<Backoff> | null>(backoffPath(directory), null)
  return value !== null && typeof value.until === 'string' && !Number.isNaN(Date.parse(value.until)) && typeof value.reason === 'string' && typeof value.streak === 'number' ? (value as Backoff) : null
}

export function writeBackoff(directory: string, backoff: Backoff): void {
  try {
    const path = backoffPath(directory)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(backoff), { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // Not being able to write it means the next call asks GitHub, which says it again.
  }
}

export function clearBackoff(directory: string): void {
  try {
    writeFileSync(backoffPath(directory), 'null\n', { mode: 0o600 })
  } catch {
    // Nothing to clear.
  }
}

/** The wait still ahead of `now`, or null when there is none. */
export const activeBackoff = (backoff: Backoff | null, now: Date): Backoff | null => (backoff !== null && now.getTime() < Date.parse(backoff.until) ? backoff : null)
