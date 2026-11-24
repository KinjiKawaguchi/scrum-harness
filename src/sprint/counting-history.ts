import type { Paths } from '../store.ts'
import { loadRecords, type CheckpointRecord } from './record.ts'
import { loadTeamStop, NEVER_STOPPED, type TeamStop } from './team-stop.ts'

/**
 * 手間 (作業中にまたいだ節目の数) を数えるときの、過去の記録。`assessItem` の入力は、これだけ。
 * 数えるときに見るものを足すときは、ここに項目を足し、`loadCountingHistory` で読み、`assessItem` で使う。
 */
export type CountingHistory = {
  /** 節目の記録。issue ごとの、止まっていた節目を残している */
  readonly records: readonly CheckpointRecord[]
  /** 全セッションが止まっていた時間 */
  readonly teamStop: TeamStop
}

/** 何も記録が無いときの入力。どの節目も除かない。 */
export const EMPTY_HISTORY: CountingHistory = { records: [], teamStop: NEVER_STOPPED }

/** 節目の記録と、全セッションが止まっていた時間を、1 回で読む。 */
export function loadCountingHistory(p: Paths, now: Date): CountingHistory {
  return { records: loadRecords(p), teamStop: loadTeamStop(p, now) }
}
