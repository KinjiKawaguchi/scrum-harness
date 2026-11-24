import { label } from '../board/rules.ts'
import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { gh } from '../github.ts'

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

function fieldId(config: Config, fieldName: string): string {
  const query = 'query($id:ID!, $name:String!){ node(id:$id){ ... on ProjectV2 { field(name:$name){ ... on ProjectV2FieldCommon{ id } } } } }'
  const out = gh(['api', 'graphql', '-f', `query=${query}`, '-F', `id=${config.projectId}`, '-f', `name=${fieldName}`, '--jq', '.data.node.field.id'])
  const id = out.trim()
  if (id === '' || id === 'null') throw new Error(`ボードに欄「${fieldName}」が無い`)
  return id
}

/** 計画した値をボードに書く。1件の失敗で止めず、失敗したものを返す。 */
export function applyMarks(marks: readonly Mark[], config: Config): readonly string[] {
  const fieldName = config.sprint?.overrunField
  if (fieldName === undefined || marks.length === 0) return []
  const id = fieldId(config, fieldName)
  return marks.flatMap((mark) => {
    const value = mark.value === null ? ['--clear'] : ['--number', String(mark.value)]
    try {
      gh(['project', 'item-edit', '--project-id', config.projectId, '--id', mark.itemId, '--field-id', id, ...value])
      return []
    } catch (error) {
      return [`${mark.label}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`]
    }
  })
}
