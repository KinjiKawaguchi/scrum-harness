import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { appendLine, readText, type Paths } from '../store.ts'
import { assessItem, type Assessment } from './assess.ts'
import { latestCheckpoint } from './checkpoints.ts'
import type { CountingHistory } from './counting-history.ts'

export type CheckpointItem = Assessment & { readonly reason: string | null; readonly tanto: string | null }

/** 節目の記録。その時点の作業中の issue ごとの見積もりと手間を残す。 */
export type CheckpointRecord = {
  readonly scheduledFor: string
  readonly recordedAt: string
  /** 記録に使ったボードの控えの時刻。取り直しに失敗すると節目より古いことがある */
  readonly snapshotAt?: string
  readonly items: readonly CheckpointItem[]
}

/** 作業中の開いている issue (除く作者を除く)。 */
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
    tanto: item.tanto,
  }))
  return { scheduledFor: scheduledFor.toISOString(), recordedAt: now.toISOString(), snapshotAt: snapshot.fetchedAt, items }
}

/** まだ記録していない、今以前の最後の節目。記録済みなら null。 */
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
        return [JSON.parse(line) as CheckpointRecord]
      } catch {
        return []
      }
    })
}

export function appendRecord(p: Paths, record: CheckpointRecord): void {
  appendLine(p.checkpoints, JSON.stringify(record))
}
