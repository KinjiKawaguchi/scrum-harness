import type { Config } from '../../config.ts'
import type { GhRun } from './gh.ts'

export type SingleSelectField = {
  readonly id: string
  readonly options: readonly { readonly id: string; readonly name: string }[]
}

const FIELD_QUERY =
  'query($id:ID!, $name:String!){ node(id:$id){ ... on ProjectV2 { field(name:$name){ ... on ProjectV2SingleSelectField { id options{ id name } } } } } }'

/** The board's single-select field of that name with its options, or null when the board has none. */
export function singleSelectField(run: GhRun, config: Config, name: string): SingleSelectField | null {
  const out = run(['api', 'graphql', '-f', `query=${FIELD_QUERY}`, '-F', `id=${config.projectId}`, '-f', `name=${name}`])
  const field = (JSON.parse(out) as { data?: { node?: { field?: { id?: string; options?: readonly { id?: string; name?: string }[] } | null } | null } }).data?.node?.field
  if (field === undefined || field === null || typeof field.id !== 'string' || field.options === undefined) return null
  const options = field.options.flatMap((one) => (typeof one.id === 'string' && typeof one.name === 'string' ? [{ id: one.id, name: one.name }] : []))
  return { id: field.id, options }
}

/** The option's id. Throws, naming the options there are, when the field has no such option. */
export function optionIdOf(field: SingleSelectField, fieldName: string, option: string): string {
  const found = field.options.find((one) => one.name === option)
  if (found === undefined) throw new Error(`"${option}" is not an option of the board's "${fieldName}" field (${field.options.map((one) => one.name).join(', ')})`)
  return found.id
}
