import { label } from '../../board/rules.ts'
import type { BoardItem } from '../../board/types.ts'
import { shortRepo, type Config } from '../../config.ts'
import type { GhRun } from './gh.ts'
import type { StatusEvent } from '../../sprint/effort.ts'

/** The number of Status changes read for one issue. Even if an issue goes in and out of In Progress many times, this many are enough. */
const EVENTS_PER_ISSUE = 50

/** The issues whose Status changes are read. repo is the repository's full name (owner/name), taken as is from the board item. */
export type HistoryTarget = { readonly repo: string; readonly number: number }

type Group = { readonly alias: string; readonly repo: string; readonly numbers: readonly number[] }

/**
 * Groups issue numbers by repository. The repository is the item's repo, used as is. If it were looked up again from the short name in the label (`app#5`),
 * a repository that is not in the config's repos (when an issue of another repository was added to the board) would be mistaken for the same number in defaultRepo (a different issue or PR).
 */
function groupByRepo(targets: readonly HistoryTarget[]): readonly Group[] {
  const byRepo = targets.reduce<ReadonlyMap<string, readonly number[]>>(
    (acc, target) => new Map([...acc, [target.repo, [...(acc.get(target.repo) ?? []), target.number]]]),
    new Map(),
  )
  return [...byRepo].map(([repo, numbers], index) => ({ alias: `r${index}`, repo, numbers }))
}

/** Asks for the Status changes of the In Progress issues in a single query, grouped by repository. */
export function statusHistoryQuery(targets: readonly HistoryTarget[]): string {
  const parts = groupByRepo(targets).map((group) => {
    const [owner, name] = group.repo.split('/')
    const issues = group.numbers.map(
      (number) =>
        `i${number}: issue(number:${number}){ timelineItems(itemTypes:[PROJECT_V2_ITEM_STATUS_CHANGED_EVENT], last:${EVENTS_PER_ISSUE}){ nodes{ ... on ProjectV2ItemStatusChangedEvent{ createdAt status project{ id } } } } }`,
    )
    return `${group.alias}: repository(owner:"${owner}", name:"${name}"){ ${issues.join(' ')} }`
  })
  return `query{ ${parts.join(' ')} }`
}

type RawEvent = { readonly createdAt?: string; readonly status?: string | null; readonly project?: { readonly id?: string } | null }
type RawResponse = { readonly data?: Record<string, Record<string, { readonly timelineItems?: { readonly nodes?: readonly RawEvent[] } } | null> | null> }

/**
 * From the query's result, extracts only this board's Status changes, per label.
 * An issue that could not be read (result null) is left out. If it were included, it would be read as "In Progress period is 0" rather than "no record", and the effort would become 0.
 */
export function parseStatusHistory(response: RawResponse, targets: readonly HistoryTarget[], config: Config): ReadonlyMap<string, readonly StatusEvent[]> {
  const entries = groupByRepo(targets).flatMap((group) =>
    group.numbers.flatMap((number): [string, readonly StatusEvent[]][] => {
      const node = response.data?.[group.alias]?.[`i${number}`]
      if (node === null || node === undefined) return []
      const events = (node.timelineItems?.nodes ?? [])
        .filter((one) => one.project?.id === config.projectId && typeof one.createdAt === 'string')
        .map((one) => ({ at: one.createdAt ?? '', status: one.status ?? null }))
      return [[`${shortRepo(group.repo)}#${number}`, events]]
    }),
  )
  return new Map(entries)
}

/**
 * The answer of gh's query. When some issues cannot be read (the number is a PR, or the issue vanished), GraphQL keeps the other results but
 * the exit code becomes 1 and gh throws an exception. The part that was read remains in the exception's standard output, so it is used (one issue's failure does not discard everyone's effort).
 */
function readHistory(run: GhRun, query: string): RawResponse | null {
  try {
    return JSON.parse(run(['api', 'graphql', '-f', `query=${query}`])) as RawResponse
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout
    if (typeof stdout !== 'string') return null
    try {
      const partial = JSON.parse(stdout) as RawResponse
      return partial.data === undefined || partial.data === null ? null : partial
    } catch {
      return null
    }
  }
}

/** Reads the Status changes of the specified issues, per label. null if it cannot be read (so "no record" and "period is 0" are not confused). */
export function statusEventsFor(items: readonly BoardItem[], config: Config, run: GhRun): ReadonlyMap<string, readonly StatusEvent[]> | null {
  const targets = items.flatMap((item): HistoryTarget[] => (item.kind === 'issue' && item.number !== null ? [{ repo: item.repo, number: item.number }] : []))
  if (targets.length === 0) return new Map()
  const response = readHistory(run, statusHistoryQuery(targets))
  return response === null ? null : parseStatusHistory(response, targets, config)
}

const isDoing = (item: BoardItem, config: Config): boolean =>
  item.kind === 'issue' && item.state === 'OPEN' && item.status === config.statuses.doing && item.number !== null

/**
 * If there is a sprint config, adds the Status change record to In Progress issues. If it cannot be fetched, it is not added
 * (only the effort becomes unknown, and the other findings can still be raised, so the whole fetch is not treated as a failure).
 */
export function withStatusHistory(items: readonly BoardItem[], config: Config, run: GhRun): readonly BoardItem[] {
  if (config.sprint === undefined) return items
  const doing = items.filter((item) => isDoing(item, config))
  if (doing.length === 0) return items
  const history = statusEventsFor(doing, config, run)
  if (history === null) return items
  return items.map((item) => {
    const events = history.get(label(item))
    return events === undefined ? item : { ...item, statusEvents: events }
  })
}
