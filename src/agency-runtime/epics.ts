import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import type { Config } from '../config.ts'
import { epicDoneAt, EMPTY_DONE_TIMES, type DoneTimes } from './done-at.ts'
import { runtimeOf } from './config.ts'
import { blockedReasonOf, isFinished, workStatusOf } from './work.ts'
import type { BlockedReason, EpicForecast } from './types.ts'

/** The refs of the items that other items name as their parent. Empty unless the board is read with parents (dispatch or alerts). */
export function epicRefsOf(items: readonly BoardItem[]): ReadonlySet<string> {
  return new Set(items.flatMap((item) => (item.epic === null || item.epic === undefined ? [] : [item.epic])))
}

const BASIS = 'No forecast: this harness does not compute throughput'

function forecastOf(ref: string, children: readonly BoardItem[], parent: BoardItem | undefined, config: Config, doneAt: string | undefined): EpicForecast {
  const statuses = children.map((child) => workStatusOf(child, config))
  const unfinished = children.filter((_, index) => !isFinished(statuses[index] ?? null))
  const reasons = unfinished.flatMap((child) => blockedReasonOf(child, config) ?? [])
  const counts = new Map<BlockedReason, number>()
  reasons.forEach((reason) => counts.set(reason, (counts.get(reason) ?? 0) + 1))
  const points = unfinished.reduce((sum, child) => sum + (typeof child.points === 'number' && Number.isInteger(child.points) && child.points > 0 ? child.points : 0), 0)
  return {
    ref,
    title: parent?.title ?? ref,
    total: children.length,
    done: statuses.filter(isFinished).length,
    doing: statuses.filter((status) => status === 'inProgress').length,
    remainingPoints: points,
    blocked: [...counts].map(([reason, count]) => ({ reason, count })),
    basis: BASIS,
    ...(doneAt === undefined ? {} : { doneAt: new Date(doneAt).toISOString() }),
  }
}

/** How long an epic stays in the view after its last child was finished, in days. */
export const DEFAULT_FINISHED_EPIC_DAYS = 30

/**
 * Epics that still have unfinished children, in ref order, and the epics that finished within `finishedEpicDays` (default 30) with the time their last
 * child was finished. A finished epic whose time is not known is not reported: a date is never guessed.
 */
export function epicForecasts(items: readonly BoardItem[], config: Config, times: DoneTimes = EMPTY_DONE_TIMES, now: Date = new Date()): EpicForecast[] {
  const days = runtimeOf(config).finishedEpicDays ?? DEFAULT_FINISHED_EPIC_DAYS
  const children = Map.groupBy(
    items.filter((item) => item.kind === 'issue' && item.epic != null && !config.excludeAuthors.includes(item.author ?? '')),
    (item) => item.epic as string,
  )
  return [...children]
    .map(([ref, group]) => {
      const finished = group.every((child) => isFinished(workStatusOf(child, config)))
      return forecastOf(ref, group, items.find((item) => label(item) === ref), config, finished ? epicDoneAt(group, times, config) : undefined)
    })
    .filter((epic) => epic.done < epic.total || (epic.doneAt !== undefined && now.getTime() - Date.parse(epic.doneAt) <= days * 86_400_000))
    .toSorted((a, b) => a.ref.localeCompare(b.ref, 'en', { numeric: true }))
}
