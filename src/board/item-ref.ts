import { label } from './rules.ts'
import type { BoardItem, Snapshot } from './types.ts'

/**
 * The rule Agency's nodes and clients apply to the reference of a work item that waits for a decision: it becomes the target of the decision
 * envelope, which is accepted only as 1 to 120 bytes of ASCII letters, digits, and `.` `_` `#` `-`. An item that does not fit shows on the board
 * but cannot be judged, so a board module has to map its tracker's ids into the rule (and keep the display text separately).
 */
export const ITEM_REF = /^[A-Za-z0-9._#-]{1,120}$/

export const isItemRef = (text: string): boolean => ITEM_REF.test(text)

/** What is wrong with the references of the items, one line per item (at most `limit`), or an empty list. */
export function itemRefProblems(items: readonly BoardItem[], limit = 5): readonly string[] {
  return items
    .map((item) => label(item))
    .filter((ref) => !isItemRef(ref))
    .slice(0, limit)
    .map((ref) => `the reference ${JSON.stringify(ref.slice(0, 60))} does not fit 1 to 120 bytes of letters, digits, and . _ # - (Agency refuses it as a decision target)`)
}

/** Throws, naming the items, when a snapshot has a reference that does not fit. */
export function assertItemRefs(snapshot: Snapshot): void {
  const problems = itemRefProblems(snapshot.items)
  if (problems.length > 0) throw new Error(`the board module returned an item that cannot be judged: ${problems.join('; ')}`)
}
