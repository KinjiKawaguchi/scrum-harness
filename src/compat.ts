/**
 * Aliases for names that the configuration and the saved state accept besides the current ones.
 * `tanto` is an alias of `assignee` and `setTanto` of `setAssignee`; the rule `B-DOING-NO-TANTO` is an alias of `B-DOING-NO-ASSIGNEE`.
 * The current name wins when both are present.
 */

type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Copies `from` to `to` unless `to` is set, and drops `from`. */
function aliased(section: unknown, from: string, to: string): unknown {
  if (!isObj(section) || !(from in section)) return section
  const { [from]: value, ...rest } = section
  return to in rest ? rest : { ...rest, [to]: value }
}

/** A configuration record with `fields.tanto` and `scripts.setTanto` read as `fields.assignee` and `scripts.setAssignee`. */
export function withConfigAliases(record: Obj): Obj {
  const sections = [['fields', 'tanto', 'assignee'], ['scripts', 'setTanto', 'setAssignee']] as const
  return Object.fromEntries(Object.entries(record).map(([key, value]) => {
    const section = sections.find(([name]) => name === key)
    return [key, section === undefined ? value : aliased(value, section[1], section[2])]
  }))
}

/** A saved board item or checkpoint item with `tanto` read as `assignee`. */
export function withAssignee<T extends object>(item: T): T {
  return aliased(item, 'tanto', 'assignee') as T
}

const RULE_ALIASES: Readonly<Record<string, string>> = { 'B-DOING-NO-TANTO': 'B-DOING-NO-ASSIGNEE' }

/** The current name of a rule that was saved under an alias, for example in an acknowledgement. */
export const currentRuleName = (rule: string): string => RULE_ALIASES[rule] ?? rule
