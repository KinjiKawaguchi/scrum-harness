import type { BoardItem, OpenIssue } from './types.ts'

/**
 * Several teams can share one board, told apart by a single-select field (`field`, for example "Team"). This team owns the items whose
 * field has `value`. If absent, the whole board is the team's, as before.
 */
export type TeamScope = {
  readonly field: string
  readonly value: string
  /** The team also owns the items with no value in the field, and the issues that are not on the board at all. At most one team on a board sets it. */
  readonly adoptsUnassigned: boolean
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** undefined when the section is absent, null when it is of the wrong shape. A wrong shape must not fall back to the whole board, which would show another team's items. */
export function parseTeamScope(raw: unknown): TeamScope | null | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null) return null
  const { field, value, adoptsUnassigned } = raw as Record<string, unknown>
  if (!isNonEmptyString(field) || !isNonEmptyString(value)) return null
  if (adoptsUnassigned !== undefined && typeof adoptsUnassigned !== 'boolean') return null
  return { field, value, adoptsUnassigned: adoptsUnassigned === true }
}

/** The repository's short name and the number, as B-OFF-BOARD matches items to issues. */
const keyOf = (item: { readonly repo: string; readonly number: number | null }): string => `${item.repo.split('/').pop()}#${item.number ?? '?'}`

const isOwn = (item: BoardItem, scope: TeamScope): boolean => item.team === scope.value || (scope.adoptsUnassigned && (item.team ?? null) === null)

/**
 * Narrows what was read from the whole board to this team's part. The checks keep reading a snapshot and need to know nothing about teams.
 * An open issue that is on the board under another team is not "off the board", so it is left out of `openIssues`. A team that does not adopt
 * unassigned work sees no open issue but its own.
 */
export function scopeToTeam(items: readonly BoardItem[], openIssues: readonly OpenIssue[], scope: TeamScope | undefined): { readonly items: readonly BoardItem[]; readonly openIssues: readonly OpenIssue[] } {
  if (scope === undefined) return { items, openIssues }
  const own = items.filter((item) => isOwn(item, scope))
  const ownKeys = new Set(own.map(keyOf))
  const elsewhere = new Set(items.filter((item) => !isOwn(item, scope)).map(keyOf))
  const visible = scope.adoptsUnassigned ? openIssues.filter((open) => !elsewhere.has(keyOf(open))) : openIssues.filter((open) => ownKeys.has(keyOf(open)))
  return { items: own, openIssues: visible }
}
