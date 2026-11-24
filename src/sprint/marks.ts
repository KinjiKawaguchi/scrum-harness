import { label } from '../board/rules.ts'
import type { Snapshot } from '../board/types.ts'

/** The value written in the board's "Overrun" field. null means empty. */
export type Mark = { readonly itemId: string; readonly label: string; readonly value: number | null }

/**
 * Rewrites only issues whose exceeded number differs from the board. For an issue that is In Progress and exceeded, that number;
 * for the rest (not exceeded, or not In Progress), empty.
 */
export function planMarks(snapshot: Snapshot, overByLabel: ReadonlyMap<string, number>): readonly Mark[] {
  return snapshot.items
    .filter((item) => item.kind === 'issue')
    .flatMap((item): readonly Mark[] => {
      const over = overByLabel.get(label(item)) ?? 0
      const desired = over > 0 ? over : null
      return desired === (item.overrun ?? null) ? [] : [{ itemId: item.itemId, label: label(item), value: desired }]
    })
}
