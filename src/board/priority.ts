import { label } from './rules.ts'
import type { BoardItem } from './types.ts'

/** The order in which work is handed out, highest first. `deferred` is not handed out at all. */
export const PRIORITIES = ['highest', 'high', 'medium', 'low', 'deferred'] as const
export type Priority = (typeof PRIORITIES)[number]

/** The board's option as a priority (its words, in any case); null for an option that is none of the five. */
export function parsePriority(name: string | null | undefined): Priority | null {
  const word = name?.trim().toLowerCase()
  return PRIORITIES.find((priority) => priority === word) ?? null
}

/** Where a priority comes in handing work out: 0 is first. Work with no priority comes after `low`, and `deferred` is not handed out. */
export const priorityRank = (priority: Priority | null): number => (priority === null ? PRIORITIES.indexOf('low') + 1 : PRIORITIES.indexOf(priority))

/**
 * What an item's work is ordered by: its own priority, else its epic's. The one place that says so: the dispatch orders work by it and the `tickets`
 * answer reports it. `itemOf` finds an item by its reference; an epic that is not on the board has no priority to give.
 */
export function effectivePriority(item: BoardItem, itemOf: (ref: string) => BoardItem | undefined): Priority | null {
  if (item.priority !== undefined && item.priority !== null) return item.priority
  const parent = item.epic === undefined || item.epic === null ? undefined : itemOf(item.epic)
  return parent?.priority ?? null
}

/** A lookup of the board's items by their reference. */
export const itemsByRef = (items: readonly BoardItem[]): ((ref: string) => BoardItem | undefined) => {
  const byRef = new Map(items.map((item) => [label(item), item]))
  return (ref) => byRef.get(ref)
}
