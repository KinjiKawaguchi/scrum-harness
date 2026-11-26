import type { Config } from '../config.ts'
import { isItemRef } from './item-ref.ts'
import { label } from './rules.ts'
import type { Snapshot } from './types.ts'

const KINDS = ['issue', 'pr', 'draft']
const STATES = ['OPEN', 'CLOSED', 'MERGED']
const DATE = /^\d{4}-\d{2}-\d{2}$/

const isText = (value: unknown): value is string => typeof value === 'string'
const isTextOrNull = (value: unknown): boolean => value === null || value === undefined || typeof value === 'string'

/**
 * What is wrong with a snapshot a board adapter returned, one line each (at most `limit`). A module author runs it through `scrum adapter check`.
 * It checks the shape the core relies on, the reference rule, that references are unique, and that every Status is one the configuration names.
 */
export function snapshotProblems(snapshot: Snapshot, config: Config, limit = 20): readonly string[] {
  const problems: string[] = []
  const add = (text: string): void => void problems.push(text)
  if (!isText(snapshot.fetchedAt) || Number.isNaN(Date.parse(snapshot.fetchedAt))) add('fetchedAt must be an ISO 8601 time')
  if (!Array.isArray(snapshot.items)) add('items must be a list')
  if (!Array.isArray(snapshot.openIssues)) add('openIssues must be a list (it may be empty)')
  if (!Array.isArray(snapshot.items)) return problems
  const known = new Set<string>(Object.values(config.statuses))
  const seen = new Map<string, number>()
  snapshot.items.forEach((item, index) => {
    const at = `item ${index}${isText(item?.ref) ? ` (${item.ref})` : ''}`
    if (typeof item !== 'object' || item === null) return add(`${at}: must be an object`)
    if (!isText(item.itemId) || item.itemId === '') add(`${at}: itemId must be non-empty text`)
    if (!KINDS.includes(item.kind)) add(`${at}: kind must be one of ${KINDS.join(', ')}`)
    if (!isText(item.repo)) add(`${at}: repo must be text (a project or space name)`)
    if (item.number !== null && !Number.isInteger(item.number)) add(`${at}: number must be a whole number, or null`)
    if (!isText(item.title)) add(`${at}: title must be text`)
    if (item.state !== null && !STATES.includes(item.state as string)) add(`${at}: state must be one of ${STATES.join(', ')}, or null`)
    if (!isTextOrNull(item.status) || !isTextOrNull(item.reason) || !isTextOrNull(item.owner) || !isTextOrNull(item.assignee) || !isTextOrNull(item.author)) add(`${at}: status, reason, owner, assignee, and author must be text or null`)
    if (item.since !== null && !(isText(item.since) && DATE.test(item.since))) add(`${at}: since must be YYYY-MM-DD, or null`)
    if (isText(item.status) && !known.has(item.status)) add(`${at}: Status "${item.status}" is not one the configuration names (${[...known].join(', ')})`)
    const ref = label(item)
    if (!isItemRef(ref)) add(`${at}: the reference ${JSON.stringify(ref.slice(0, 60))} does not fit 1 to 120 bytes of letters, digits, and . _ # -`)
    seen.set(ref, (seen.get(ref) ?? 0) + 1)
  })
  for (const [ref, count] of seen) if (count > 1) add(`the reference ${ref} names ${count} items`)
  return problems.slice(0, limit)
}
