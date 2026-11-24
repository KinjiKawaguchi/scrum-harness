import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import type { Config } from '../config.ts'
import { readJson, writeJson, type Paths } from '../store.ts'

/**
 * A marker for seeing whether work on an issue has progressed. The marker at the time a nudge was sent is compared with the current marker, and if they differ, the work progressed.
 * board is the board's Status, blocked reason, assignee, and the date the block started. github is the marker taken from the code host (CodeHost.activity; null if unreadable).
 */
export type ProgressToken = { readonly board: string; readonly github: string | null }

/** Takes the marker. */
export type TokenOf = (item: BoardItem) => ProgressToken

/** The part of the marker taken from the code host (null if unreadable, or it throws). */
export type ProgressProbe = (item: BoardItem) => string | null

export function boardToken(item: BoardItem): string {
  return [item.status ?? '', item.reason ?? '', item.assignee ?? '', item.since ?? ''].join('|')
}

/** If the marker changed, the work progressed. When either is missing (no marker recorded yet), or when the code host's marker is unreadable on either side, it is not called progress. */
export function hasProgress(before: ProgressToken | undefined, after: ProgressToken | undefined): boolean {
  if (before === undefined || after === undefined) return false
  if (before.board !== after.board) return true
  return before.github !== null && after.github !== null && before.github !== after.github
}

/**
 * Per member and per issue, the marker last seen and the time the marker changed (the work progressed).
 * Held so that no nudge is sent until idleMinutes have passed since progress, and so that A-NUDGE-IGNORED compares with the same marker as the nudge decision (including the code host's marker).
 */
export type SeenProgress = { readonly token: ProgressToken; readonly at: string }
export type SeenMap = Readonly<Record<string, SeenProgress>>

export function seenKey(member: string, issue: string): string {
  return `${member}|${issue}`
}

/**
 * Remembers that the marker was seen. If it progressed compared with before (including the first time it is seen), the time is set to now; if it has not changed, the earlier time stays.
 * The entry for a different issue of the same member is dropped (if their own In Progress issue changes, the earlier issue's marker is not needed).
 */
export function observe(seen: SeenMap, member: string, issue: string, token: ProgressToken, now: Date): SeenMap {
  const before = seen[seenKey(member, issue)]
  const at = before === undefined || hasProgress(before.token, token) ? now.toISOString() : before.at
  const others = Object.entries(seen).filter(([key]) => !key.startsWith(`${member}|`))
  return Object.fromEntries([...others, [seenKey(member, issue), { token, at }]])
}

const isToken = (value: unknown): value is ProgressToken => {
  const token = value as { board?: unknown; github?: unknown } | null
  return typeof token === 'object' && token !== null && typeof token.board === 'string' && (token.github === null || typeof token.github === 'string')
}

const isSeenProgress = (value: unknown): value is SeenProgress => {
  const seen = value as { token?: unknown; at?: unknown } | null
  return typeof seen === 'object' && seen !== null && isToken(seen.token) && typeof seen.at === 'string' && !Number.isNaN(Date.parse(seen.at))
}

/** Reads the saved markers. Items that are absent or of a different shape are dropped. */
export function readSeen(p: Paths): SeenMap {
  const raw = readJson<unknown>(p.dispatchSeen, {})
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => isSeenProgress(value)))
}

export function writeSeen(p: Paths, seen: SeenMap): void {
  writeJson(p.dispatchSeen, seen)
}

/** Compares by the board's marker only, without using the code host's marker. */
export const boardOnly: TokenOf = (item) => ({ board: boardToken(item), github: null })

const CACHE_TTL_MS = 5 * 60_000

/** Reuses the reading of the same issue's marker for ttlMs (so that the watch every 30 seconds does not keep hitting the outside). Failures are reused too. */
export function cachedProbe(probe: ProgressProbe, ttlMs: number = CACHE_TTL_MS, clock: () => number = Date.now): ProgressProbe {
  const cache = new Map<string, { readonly at: number; readonly value: string | null }>()
  return (item) => {
    const key = `${item.repo}#${item.number}`
    const hit = cache.get(key)
    if (hit !== undefined && clock() - hit.at < ttlMs) return hit.value
    const value = (() => {
      try {
        return probe(item)
      } catch {
        return null
      }
    })()
    cache.set(key, { at: clock(), value })
    return value
  }
}

/**
 * The current marker combining the board's marker and the code host's marker. If unreadable, the code host's marker is null (compare by the board's marker only).
 * By the port's contract, reading the marker may throw, so it is caught here (if it reached the inside of the handover lock while still thrown, the hand-over itself would stop for several minutes).
 */
export function tokenWith(probe: ProgressProbe): TokenOf {
  return (item) => ({ board: boardToken(item), github: readProbe(probe, item) })
}

function readProbe(probe: ProgressProbe, item: BoardItem): string | null {
  try {
    return probe(item)
  } catch {
    return null
  }
}

/** The name written in the nudge record. It uses label, so whether it is the same issue is decided by repository name and number. */
export function issueLabel(item: BoardItem): string {
  return label(item)
}
