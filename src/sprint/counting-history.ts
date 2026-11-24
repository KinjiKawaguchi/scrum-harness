import type { Paths } from '../store.ts'
import { loadRecords, type CheckpointRecord } from './record.ts'
import { loadTeamStop, NEVER_STOPPED, type TeamStop } from './team-stop.ts'

/**
 * The past records used when counting effort (the number of checkpoints crossed while In Progress). `assessItem`'s only input is this.
 * To add something to look at when counting, add an item here, read it in `loadCountingHistory`, and use it in `assessItem`.
 */
export type CountingHistory = {
  /** The checkpoint records. They keep, per issue, the checkpoints that were stalled */
  readonly records: readonly CheckpointRecord[]
  /** The times when all sessions were stalled */
  readonly teamStop: TeamStop
}

/** The input when there is no record at all. No checkpoint is excluded. */
export const EMPTY_HISTORY: CountingHistory = { records: [], teamStop: NEVER_STOPPED }

/** Reads the checkpoint records and the times when all sessions were stalled in one go. */
export function loadCountingHistory(p: Paths, now: Date): CountingHistory {
  return { records: loadRecords(p), teamStop: loadTeamStop(p, now) }
}
