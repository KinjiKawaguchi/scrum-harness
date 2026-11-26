import type { AdapterCommandConfig } from '../../adapter-module.ts'
import { label } from '../../board/rules.ts'
import { snapshotProblems } from '../../board/snapshot-check.ts'
import type { Snapshot } from '../../board/types.ts'
import type { Config } from '../../config.ts'
import type { StatusEvent } from '../../sprint/effort.ts'
import { bashActionReader } from '../github/action-reader.ts'
import { withCheckedRefs, type ModulePorts } from '../module/load.ts'
import { callBoardProgram } from './call.ts'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The snapshot the program answered, with the time of the read filled in when it gave none. Not checked here: see `commandPorts`. */
function rawSnapshotOf(result: unknown, now: Date): Snapshot {
  if (!isObject(result)) throw new Error('the board program must answer a snapshot: an object with items and openIssues')
  return { ...result, fetchedAt: typeof result.fetchedAt === 'string' ? result.fetchedAt : now.toISOString() } as unknown as Snapshot
}

/** Throws, naming the problems, when a snapshot does not fit the contract, so the core never sees a shape it does not expect. */
function assertSnapshotFits(snapshot: Snapshot, config: Config): Snapshot {
  const problems = snapshotProblems(snapshot, config, 5)
  if (problems.length > 0) throw new Error(`the board program returned a snapshot that does not fit the contract: ${problems.join('; ')}`)
  return snapshot
}

/** ref -> Status changes, or null when the program cannot say (the same meaning as the port's null). A malformed answer is null, not a guess. */
function statusEventsOf(result: unknown): ReadonlyMap<string, readonly StatusEvent[]> | null {
  if (!isObject(result)) return null
  const isEvent = (one: unknown): one is StatusEvent => isObject(one) && typeof one.at === 'string' && !Number.isNaN(Date.parse(one.at)) && (one.status === null || typeof one.status === 'string')
  const entries = Object.entries(result)
  return entries.every(([, events]) => Array.isArray(events) && events.every(isEvent)) ? new Map(entries as [string, StatusEvent[]][]) : null
}

/** The ports of the program as they are, without checking what it answers (`scrum adapter check` checks it and lists every problem). */
export function rawCommandPorts(spec: AdapterCommandConfig, config: Config): ModulePorts {
  return {
    board: {
      fetchSnapshot: (now) => rawSnapshotOf(callBoardProgram(spec, { op: 'snapshot', now: now.toISOString() }), now),
      statusEvents: (items) => {
        try {
          return statusEventsOf(callBoardProgram(spec, { op: 'statusEvents', items: items.map((item) => label(item)) }))
        } catch {
          return null
        }
      },
    },
    actions: bashActionReader(config),
  }
}

/**
 * The ports of a team whose board is a program that speaks `scrum-board/1`. Reading is always there; what else the program can do is named in its
 * `capabilities`, and the harness offers (and calls) only that. The agents' own board writes are read the way they are for GitHub: from the
 * `scripts` named in the configuration. Every snapshot is checked before the core sees it.
 */
export function commandPorts(spec: AdapterCommandConfig, config: Config): ModulePorts {
  const raw = rawCommandPorts(spec, config)
  const board = raw.board
  if (board === undefined) return raw
  return withCheckedRefs({ ...raw, board: { ...board, fetchSnapshot: (now) => assertSnapshotFits(board.fetchSnapshot(now), config) } })
}
