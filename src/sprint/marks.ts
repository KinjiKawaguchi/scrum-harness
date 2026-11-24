import { label } from '../board/rules.ts'
import type { Snapshot } from '../board/types.ts'

/** ボードの「超過」の欄に書く値。null は空にする。 */
export type Mark = { readonly itemId: string; readonly label: string; readonly value: number | null }

/**
 * 超えた数がボードと違う issue だけを書き換える。作業中で超えている issue はその数、
 * それ以外 (超えていない、作業中でない) は空にする。
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
