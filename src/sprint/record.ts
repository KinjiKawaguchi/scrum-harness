import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { withAssignee } from '../compat.ts'
import { appendLine, readText, type Paths } from '../store.ts'
import { assessItem, type Assessment } from './assess.ts'
import { latestCheckpoint } from './checkpoints.ts'
import type { CountingHistory } from './counting-history.ts'

export type CheckpointItem = Assessment & { readonly reason: string | null; readonly assignee: string | null }

/** The checkpoint record. It keeps, per In Progress issue at that moment, the estimate and the effort. */
export type CheckpointRecord = {
  readonly scheduledFor: string
  readonly recordedAt: string
  /** The time of the board copy used for the record. If the re-fetch failed, it may be older than the checkpoint */
  readonly snapshotAt?: string
  readonly items: readonly CheckpointItem[]
}

/** Open In Progress issues (excluding excluded authors). */
export function doingIssues(snapshot: Snapshot, config: Config) {
  return snapshot.items.filter(
    (item) =>
      item.kind === 'issue' &&
      item.state === 'OPEN' &&
      item.status === config.statuses.doing &&
      !config.excludeAuthors.includes(item.author ?? ''),
  )
}

export function buildRecord(
  snapshot: Snapshot,
  history: CountingHistory,
  config: Config,
  scheduledFor: Date,
  now: Date,
): CheckpointRecord {
  const items = doingIssues(snapshot, config).map((item) => ({
    ...assessItem(item, history, config, now),
    reason: item.reason,
    assignee: item.assignee,
  }))
  return { scheduledFor: scheduledFor.toISOString(), recordedAt: now.toISOString(), snapshotAt: snapshot.fetchedAt, items }
}

/** The last checkpoint at or before now that has not yet been recorded. null if already recorded. */
export function dueCheckpoint(records: readonly CheckpointRecord[], config: Config, now: Date): Date | null {
  if (config.sprint === undefined) return null
  const latest = latestCheckpoint(now, config.sprint)
  return records.some((record) => record.scheduledFor === latest.toISOString()) ? null : latest
}

export function loadRecords(p: Paths): readonly CheckpointRecord[] {
  return readText(p.checkpoints)
    .split('\n')
    .filter((line) => line !== '')
    .flatMap((line): readonly CheckpointRecord[] => {
      try {
        const record = JSON.parse(line) as CheckpointRecord
        return [{ ...record, items: record.items.map(withAssignee) }]
      } catch {
        return []
      }
    })
}

export function appendRecord(p: Paths, record: CheckpointRecord): void {
  appendLine(p.checkpoints, JSON.stringify(record))
}
