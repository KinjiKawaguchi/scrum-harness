import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import type { Config } from '../config.ts'
import { blockedReasonOf, isFinished, workStatusOf } from './work.ts'
import type { BlockedReason, EpicForecast } from './types.ts'

/** The refs of the items that other items name as their parent. Empty unless the board is read with parents (dispatch or alerts). */
export function epicRefsOf(items: readonly BoardItem[]): ReadonlySet<string> {
  return new Set(items.flatMap((item) => (item.epic === null || item.epic === undefined ? [] : [item.epic])))
}

const BASIS = 'No forecast: this harness does not compute throughput'

function forecastOf(ref: string, children: readonly BoardItem[], parent: BoardItem | undefined, config: Config): EpicForecast {
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
  }
}

/** Epics that still have unfinished children, in ref order. Finished epics are not reported. */
export function epicForecasts(items: readonly BoardItem[], config: Config): readonly EpicForecast[] {
  const children = Map.groupBy(
    items.filter((item) => item.kind === 'issue' && item.epic != null && !config.excludeAuthors.includes(item.author ?? '')),
    (item) => item.epic as string,
  )
  return [...children]
    .map(([ref, group]) => forecastOf(ref, group, items.find((item) => label(item) === ref), config))
    .filter((epic) => epic.done < epic.total)
    .toSorted((a, b) => a.ref.localeCompare(b.ref, 'en', { numeric: true }))
}
