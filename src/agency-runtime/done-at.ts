import { label } from '../board/rules.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { readJson, writeJson } from '../store.ts'
import { isFinished, workStatusOf } from './work.ts'

/**
 * When the harness saw items reach `done` (the Status) and become finished (`release` or `done`), by item reference. Kept in the state directory so a
 * restart does not lose it. Only a change the harness watched happen is recorded: an item that was already finished the first time it was seen has
 * no time here, and its date, when there is one, comes from the tracker (a closed issue's close time). A date is never guessed.
 */
export type DoneEntry = { readonly finishedAt?: string; readonly doneAt?: string }
export type DoneTimes = { readonly version: 1; readonly entries: Readonly<Record<string, DoneEntry>> }

export const EMPTY_DONE_TIMES: DoneTimes = { version: 1, entries: {} }

export function readDoneTimes(path: string): DoneTimes {
  const value = readJson<DoneTimes | null>(path, null)
  return value !== null && value.version === 1 && typeof value.entries === 'object' && value.entries !== null ? value : EMPTY_DONE_TIMES
}

export const writeDoneTimes = (path: string, times: DoneTimes): void => writeJson(path, times)

const isTime = (value: string | undefined): value is string => value !== undefined && !Number.isNaN(Date.parse(value))
const earliest = (times: readonly (string | undefined)[]): string | undefined => times.filter(isTime).toSorted((a, b) => Date.parse(a) - Date.parse(b))[0]

/**
 * The record with what a read shows: an item that was not finished (or not done) in the previous read and is now gets the time of the new read. Nothing
 * is recorded without a previous read, for an item the previous read did not have, or for a time already there (the first time is kept when an item
 * goes back and is done again). Returns the same object when nothing changed.
 */
export function recordDone(previous: Snapshot | null, fresh: Snapshot, config: Config, prior: DoneTimes): DoneTimes {
  if (previous === null) return prior
  const before = new Map(previous.items.map((item) => [label(item), item]))
  const at = new Date(fresh.fetchedAt).toISOString()
  const added = fresh.items.flatMap((item): readonly (readonly [string, DoneEntry])[] => {
    const ref = label(item)
    const was = before.get(ref)
    const status = workStatusOf(item, config)
    if (item.kind !== 'issue' || was === undefined) return []
    const wasStatus = workStatusOf(was, config)
    const known = prior.entries[ref] ?? {}
    const finishedAt = isFinished(status) && !isFinished(wasStatus) && known.finishedAt === undefined ? { finishedAt: at } : {}
    const doneAt = status === 'done' && wasStatus !== 'done' && known.doneAt === undefined ? { doneAt: at } : {}
    return Object.keys(finishedAt).length + Object.keys(doneAt).length === 0 ? [] : [[ref, { ...known, ...finishedAt, ...doneAt }]]
  })
  return added.length === 0 ? prior : { version: 1, entries: { ...prior.entries, ...Object.fromEntries(added) } }
}

/** A closed issue's close time, which is where the tracker knows when it was finished. */
const closedAtOf = (item: BoardItem): string | undefined => (item.state === 'CLOSED' ? item.closedAt : undefined)

/** When an item first reached `done`: the earlier of what the harness saw and the tracker's close time. Undefined when it is not done, or the time is not known. */
export function doneAtOf(item: BoardItem, times: DoneTimes, config: Config): string | undefined {
  if (workStatusOf(item, config) !== 'done') return undefined
  return earliest([times.entries[label(item)]?.doneAt, closedAtOf(item)])
}

/** When an item first became finished (`release` or `done`), by the same rule. */
export function finishedAtOf(item: BoardItem, times: DoneTimes, config: Config): string | undefined {
  if (!isFinished(workStatusOf(item, config))) return undefined
  return earliest([times.entries[label(item)]?.finishedAt, closedAtOf(item)])
}

/** When the last of an epic's children became finished. Undefined unless every child is finished and every time is known. */
export function epicDoneAt(children: readonly BoardItem[], times: DoneTimes, config: Config): string | undefined {
  const at = children.map((child) => finishedAtOf(child, times, config))
  if (children.length === 0 || at.some((one) => one === undefined)) return undefined
  return (at as readonly string[]).toSorted((a, b) => Date.parse(b) - Date.parse(a))[0]
}
