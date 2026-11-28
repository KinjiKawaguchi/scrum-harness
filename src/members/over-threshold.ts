import { readJson, writeJson } from '../store.ts'

/** A member that is left on a source past its threshold (or blocked), and why it was not moved. */
export type LeftOver = { readonly name: string; readonly source: string; readonly reason: string }

/** What is kept of it: the time the member was first seen on that source past its threshold, so the finding can say for how long. */
export type OverRecord = LeftOver & { readonly since: string }

export const readOver = (path: string): readonly OverRecord[] => readJson<readonly OverRecord[]>(path, [])

/**
 * Keeps the members that are left on a source past its threshold. A member that stays on the same source keeps its first time; one that is not left any more
 * is dropped. With `only`, just that member's entry is replaced and the others are kept (a refusal looks at one member, not at the team).
 */
export function writeOver(path: string, left: readonly LeftOver[], now: Date, only?: string): void {
  const before = readOver(path)
  const kept = only === undefined ? [] : before.filter((one) => one.name !== only)
  const records = left.map((one): OverRecord => ({ ...one, since: before.find((was) => was.name === one.name && was.source === one.source)?.since ?? now.toISOString() }))
  const next = [...kept, ...records]
  if (JSON.stringify(next) !== JSON.stringify(before)) writeJson(path, next)
}
