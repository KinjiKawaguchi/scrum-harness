import { label } from '../board/rules.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { appendLine, readText, type Paths } from '../store.ts'
import { assessItem } from './assess.ts'
import type { StatusEvent } from './effort.ts'
import type { BoardSource } from '../ports/index.ts'
import { loadCountingHistory, type CountingHistory } from './counting-history.ts'

/** For a finished issue, the points and the checkpoints it actually took (excluding stalled checkpoints). Kept one per line in p.completions. */
export type Completion = {
  readonly label: string
  readonly points: number | null
  readonly budget: number | null
  readonly effort: number | null
  /** The time the finish was found (ISO 8601) */
  readonly detectedAt: string
  /** The Status it finished in (Done, or Release) */
  readonly status: string
  /** Whether it was counted from the Status change record (the issue's timeline). false when it could not be read and was approximated from the record of the previous board copy */
  readonly exact: boolean
}

const isFinished = (item: BoardItem, config: Config): boolean =>
  item.kind === 'issue' && item.number !== null && (item.status === config.statuses.done || item.status === config.statuses.release)

/** Issues that were In Progress in the previous board copy and are Done or Release in the current board copy (issues by excluded authors are not included). */
export function newlyFinished(previous: Snapshot | null, fresh: Snapshot, config: Config): readonly { readonly item: BoardItem; readonly before: BoardItem }[] {
  if (previous === null) return []
  const wasDoing = new Map(previous.items.filter((item) => item.kind === 'issue' && item.status === config.statuses.doing).map((item) => [label(item), item]))
  return fresh.items.flatMap((item) => {
    const before = wasDoing.get(label(item))
    return before !== undefined && isFinished(item, config) && !config.excludeAuthors.includes(item.author ?? '') ? [{ item, before }] : []
  })
}

/** When the timeline could not be read, approximates by adding the change at the finish time to the record of the previous board copy. */
function approximateEvents(before: BoardItem, item: BoardItem, now: Date): readonly StatusEvent[] | undefined {
  return before.statusEvents === undefined ? undefined : [...before.statusEvents, { at: now.toISOString(), status: item.status }]
}

function toCompletion(
  pair: { readonly item: BoardItem; readonly before: BoardItem },
  statusHistory: ReadonlyMap<string, readonly StatusEvent[]> | null,
  countingHistory: CountingHistory,
  config: Config,
  now: Date,
): Completion {
  const { item, before } = pair
  const exactEvents = statusHistory?.get(label(item))
  const events = exactEvents ?? approximateEvents(before, item, now)
  const assessment = assessItem(events === undefined ? item : { ...item, statusEvents: events }, countingHistory, config, now)
  return {
    label: assessment.label,
    points: assessment.points,
    budget: assessment.budget,
    effort: assessment.effort,
    detectedAt: now.toISOString(),
    status: item.status ?? '',
    exact: exactEvents !== undefined,
  }
}

/**
 * Issues already recorded after the comparison baseline's board copy was taken. When recording fails midway and is redone without advancing the baseline,
 * the ones that were already recorded are not recorded a second time.
 */
function alreadyLogged(previous: Snapshot | null, completions: readonly Completion[]): ReadonlySet<string> {
  if (previous === null) return new Set()
  return new Set(completions.filter((one) => one.detectedAt > previous.fetchedAt).map((one) => one.label))
}

/**
 * When the board copy is re-fetched, records the issues that went from In Progress to finished (Done or Release), together with the points and the checkpoints they actually took.
 * If there is no sprint config, does nothing. The Status changes are asked for in a single query for only the finished issues.
 */
export function recordCompletions(
  p: Paths,
  previous: Snapshot | null,
  fresh: Snapshot,
  config: Config,
  now: Date,
  readEvents: BoardSource['statusEvents'],
): readonly Completion[] {
  if (config.sprint === undefined) return []
  const alreadyRecorded = alreadyLogged(previous, loadCompletions(p))
  const pairs = newlyFinished(previous, fresh, config).filter((pair) => !alreadyRecorded.has(label(pair.item)))
  if (pairs.length === 0) return []
  const statusHistory = readEvents(pairs.map((pair) => pair.item))
  const countingHistory = loadCountingHistory(p, now)
  const completions = pairs.map((pair) => toCompletion(pair, statusHistory, countingHistory, config, now))
  completions.forEach((one) => appendLine(p.completions, JSON.stringify(one)))
  return completions
}

export function loadCompletions(p: Paths): readonly Completion[] {
  return readText(p.completions)
    .split('\n')
    .filter((line) => line !== '')
    .flatMap((line): readonly Completion[] => {
      try {
        return [JSON.parse(line) as Completion]
      } catch {
        return []
      }
    })
}
