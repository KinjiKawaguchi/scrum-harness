import type { Config } from '../config.ts'
import type { BoardSource } from '../ports/index.ts'
import { appendEvents, trimLog } from '../activity/log.ts'
import { readDoneTimes, recordDone, writeDoneTimes } from '../agency-runtime/done-at.ts'
import { boardEvents } from '../activity/board-events.ts'
import { recordCompletions } from '../sprint/completion.ts'
import { FetchError, saveFailedFetch } from './fetch-log.ts'
import { logError, readJson, releaseLock, tryLock, writeJson, type Paths } from '../store.ts'
import { withAssignee } from '../compat.ts'
import type { Snapshot } from './types.ts'

/** A saved board copy, with every item's `tanto` read as `assignee`. */
function readSnapshot(path: string): Snapshot | null {
  const snapshot = readJson<Snapshot | null>(path, null)
  return snapshot === null ? null : { ...snapshot, items: snapshot.items.map(withAssignee) }
}

export function loadSnapshot(p: Paths): Snapshot | null {
  return readSnapshot(p.snapshot)
}

export function saveSnapshot(p: Paths, snapshot: Snapshot): void {
  writeJson(p.snapshot, snapshot)
}

/** The board copy from the last successful re-fetch. It is the baseline for the comparison that finds Done issues, and is kept separate from the board copy (loadSnapshot) that the hook writes after correcting Status. */
export function loadFetchedSnapshot(p: Paths): Snapshot | null {
  return readSnapshot(p.fetchedSnapshot)
}

export function isStale(snapshot: Snapshot | null, config: Config, now: Date): boolean {
  return snapshot === null || now.getTime() - Date.parse(snapshot.fetchedAt) > config.refreshSeconds * 1000
}

/** Whether the board copy is stale and refreshSeconds have passed since the last attempt. So that repeated failures do not use up the limit on calls to the board's host. */
export function isRefreshDue(p: Paths, config: Config, now: Date): boolean {
  if (!isStale(loadSnapshot(p), config, now)) return false
  const attemptedAt = readJson<string | null>(p.refreshAttempt, null)
  return attemptedAt === null || now.getTime() - Date.parse(attemptedAt) > config.refreshSeconds * 1000
}

/**
 * A record of issues that went from In Progress to Done. The board copy has already been written by then, so even on failure the re-fetch stays successful and the failure is left in errors.log.
 * Returns whether the record succeeded. On failure, the comparison baseline (the last fetched board copy) is not advanced, and the next re-fetch finds the same issue again.
 */
function noteCompletions(p: Paths, previous: Snapshot | null, fresh: Snapshot, config: Config, now: Date, source: BoardSource): boolean {
  try {
    recordCompletions(p, previous, fresh, config, now, source.statusEvents)
    return true
  } catch (error) {
    logError(p, 'completions', error)
    return false
  }
}

/** Writes what the read shows the team did to the activity log. A failure is left in errors.log; it never fails the re-fetch. */
function noteActivity(p: Paths, previous: Snapshot | null, fresh: Snapshot, config: Config, now: Date): void {
  try {
    appendEvents(p.activityLog, boardEvents(previous, fresh, config), now)
    trimLog(p.activityLog, now)
  } catch (error) {
    logError(p, 'activity', error)
  }
}

/** Records the items that reached done since the previous read. A failure is left in errors.log; it never fails the re-fetch. */
function noteDone(p: Paths, previous: Snapshot | null, fresh: Snapshot, config: Config): void {
  try {
    const prior = readDoneTimes(p.doneTimes)
    const next = recordDone(previous, fresh, config, prior)
    if (next !== prior) writeDoneTimes(p.doneTimes, next)
  } catch (error) {
    logError(p, 'done-at', error)
  }
}

/** Re-fetches the board and writes it to the board copy. Does nothing if another process is re-fetching. */
export function refreshSnapshot(p: Paths, config: Config, now: Date, source: BoardSource): Snapshot | null {
  if (!tryLock(p.refreshLock)) return null
  try {
    writeJson(p.refreshAttempt, now.toISOString())
    // The comparison baseline is the board copy from the last successful re-fetch. The board copy (loadSnapshot) in which the hook corrected Status after a script that rewrites Status (scripts.setStatus)
    // is already Done, so the change from In Progress to Done is not visible and it is not used. If there is none yet (the very first run), the current board copy is used
    const previous = loadFetchedSnapshot(p) ?? loadSnapshot(p)
    const snapshot = source.fetchSnapshot(now)
    saveSnapshot(p, snapshot)
    noteActivity(p, previous, snapshot, config, now)
    noteDone(p, previous, snapshot, config)
    if (noteCompletions(p, previous, snapshot, config, now, source)) writeJson(p.fetchedSnapshot, snapshot)
    return snapshot
  } catch (error) {
    logError(p, 'refresh', error)
    if (error instanceof FetchError) saveFailedFetch(p, now, error.raw)
    return null
  } finally {
    releaseLock(p.refreshLock)
  }
}
