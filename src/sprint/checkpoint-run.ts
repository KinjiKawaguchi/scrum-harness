import { loadSnapshot, refreshSnapshot } from '../board/snapshot.ts'
import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { Ports } from '../ports/index.ts'
import { appendLine, logError, releaseLock, tryLock, type Paths } from '../store.ts'
import { planMarks, type Mark } from './marks.ts'
import { appendRecord, buildRecord, dueCheckpoint, loadRecords, type CheckpointRecord } from './record.ts'
import { loadCountingHistory } from './counting-history.ts'

/**
 * If there is a checkpoint not yet recorded, records it and rewrites the board's "Overrun".
 * The rewrite is left to apply (tests do not write). null if nothing was recorded.
 */
export function recordDueCheckpoint(
  p: Paths,
  config: Config,
  snapshot: Snapshot,
  now: Date,
  apply: (marks: readonly Mark[]) => void,
): CheckpointRecord | null {
  const history = loadCountingHistory(p, now)
  const due = dueCheckpoint(history.records, config, now)
  if (due === null) return null
  const record = buildRecord(snapshot, history, config, due, now)
  appendRecord(p, record)
  if (config.sprint?.overrunField !== undefined) {
    const overByLabel = new Map(record.items.map((item) => [item.label, item.over ?? 0]))
    apply(planMarks(snapshot, overByLabel))
  }
  return record
}

/**
 * Called from the watch process and `scrum checkpoint`. If the board copy is older than the checkpoint time, re-fetches it and then records
 * (to pick up points entered just before the checkpoint), and writes the board's "Overrun". Those that could not be written are left in errors.log.
 */
export function runCheckpoint(p: Paths, config: Config, now: Date, ports: Pick<Ports, 'board' | 'writer'>): CheckpointRecord | null {
  if (config.sprint === undefined || dueCheckpoint(loadRecords(p), config, now) === null) return null
  if (!tryLock(p.checkpointLock)) return null
  try {
    return recordWithFreshSnapshot(p, config, now, ports)
  } finally {
    releaseLock(p.checkpointLock)
  }
}

/** After taking the lock, checks the checkpoint again (another process may have recorded it first) and records it. */
function recordWithFreshSnapshot(p: Paths, config: Config, now: Date, ports: Pick<Ports, 'board' | 'writer'>): CheckpointRecord | null {
  const due = dueCheckpoint(loadRecords(p), config, now)
  if (due === null) return null
  const current = loadSnapshot(p)
  const isBeforeDue = current === null || Date.parse(current.fetchedAt) < due.getTime()
  const snapshot = (isBeforeDue ? refreshSnapshot(p, config, now, ports.board) : null) ?? current
  if (snapshot === null) return null
  return recordDueCheckpoint(p, config, snapshot, now, (marks) => {
    try {
      const failed = ports.writer.writeOverrun(marks)
      if (failed.length > 0) logError(p, 'marks', failed.join('; '))
      appendLine(p.events, JSON.stringify({ at: now.toISOString(), type: 'marked', count: marks.length - failed.length }))
    } catch (error) {
      logError(p, 'marks', error)
    }
  })
}
