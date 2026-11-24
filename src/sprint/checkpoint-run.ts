import { loadSnapshot, refreshSnapshot } from '../board/snapshot.ts'
import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { Ports } from '../ports/index.ts'
import { appendLine, logError, releaseLock, tryLock, type Paths } from '../store.ts'
import { planMarks, type Mark } from './marks.ts'
import { appendRecord, buildRecord, dueCheckpoint, loadRecords, type CheckpointRecord } from './record.ts'
import { loadCountingHistory } from './counting-history.ts'

/**
 * まだ記録していない節目があれば記録し、ボードの「超過」を書き換える。
 * 書き換えは apply に任せる (試験では書かない)。記録しなければ null。
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
 * 待機プロセスと `scrum checkpoint` から呼ぶ。節目の時刻より前の控えなら取り直してから記録し
 * (節目の直前に入れたポイントを拾うため)、ボードの「超過」を書く。書けなかったものは errors.log に残す。
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

/** 錠を取ったあとに節目をもう一度確かめ (ほかのプロセスが先に記録したかもしれない)、記録する。 */
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
