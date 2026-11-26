import { workStatusOf } from '../agency-runtime/work.ts'
import { label } from '../board/rules.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { eventId } from './log.ts'
import type { ActivityEvent } from './types.ts'

const optional = <K extends string>(key: K, value: string | undefined): { readonly [P in K]?: string } => (value === undefined || value === '' ? {} : ({ [key]: value } as { [P in K]: string }))

function epicOf(item: BoardItem): { readonly epic?: string } {
  return optional('epic', item.epic ?? undefined)
}

const iso = (time: string): string => new Date(time).toISOString()

/** The limit on the text of a title or a reference in an event (the node refuses more). */
const MAX_TEXT = 200
const titleOf = (item: BoardItem): string => item.title.slice(0, MAX_TEXT)

/** An issue or a task that was added to the board, at the time GitHub says it was added. */
function itemAdded(item: BoardItem): readonly ActivityEvent[] {
  if (item.kind === 'pr' || item.addedAt === undefined) return []
  const at = iso(item.addedAt)
  return [{ id: eventId('b', 'itemAdded', label(item), at), at, kind: 'itemAdded', ref: label(item), title: titleOf(item), ...epicOf(item) }]
}

/** A pull request that is an item of the board: when it was opened, and when it was merged (with the lead time). Exact times from GitHub. */
function pullRequest(item: BoardItem): readonly ActivityEvent[] {
  if (item.kind !== 'pr') return []
  const ref = label(item)
  const base = { ref, title: titleOf(item), ...optional('issue', item.closes), ...epicOf(item) }
  const opened: readonly ActivityEvent[] = item.openedAt === undefined ? [] : [{ id: eventId('b', 'prOpened', ref, iso(item.openedAt)), at: iso(item.openedAt), kind: 'prOpened', ...base }]
  if (item.mergedAt === undefined) return opened
  const leadSeconds = item.openedAt === undefined ? undefined : Math.max(0, Math.round((Date.parse(item.mergedAt) - Date.parse(item.openedAt)) / 1000))
  const merged: ActivityEvent = { id: eventId('b', 'prMerged', ref, iso(item.mergedAt)), at: iso(item.mergedAt), kind: 'prMerged', ...base, ...(leadSeconds === undefined || Number.isNaN(leadSeconds) ? {} : { leadSeconds }) }
  return [...opened, merged]
}

/** An item whose Status is not what it was in the previous read. The time is when it was first seen, so it can be late by one refresh. */
function statusChanged(previous: ReadonlyMap<string, BoardItem>, item: BoardItem, config: Config, at: string): readonly ActivityEvent[] {
  const before = previous.get(label(item))
  if (before === undefined || item.kind === 'pr') return []
  const from = workStatusOf(before, config)
  const to = workStatusOf(item, config)
  if (from === null || to === null || from === to) return []
  return [{ id: eventId('b', 'statusChanged', label(item), from, to, at), at, kind: 'statusChanged', ref: label(item), title: titleOf(item), from, to, ...epicOf(item) }]
}

/**
 * What the board read shows the team did: items added, pull requests opened and merged (all with the times GitHub gives), and Status changes
 * since the previous read (with the time the new read was made). The same read always gives the same events, so offering one twice is harmless.
 * Without a previous read there are no Status changes.
 */
export function boardEvents(previous: Snapshot | null, fresh: Snapshot, config: Config): readonly ActivityEvent[] {
  const before = new Map((previous?.items ?? []).map((item) => [label(item), item]))
  const at = iso(fresh.fetchedAt)
  return fresh.items.flatMap((item) => [...itemAdded(item), ...pullRequest(item), ...(previous === null ? [] : statusChanged(before, item, config, at))])
}
