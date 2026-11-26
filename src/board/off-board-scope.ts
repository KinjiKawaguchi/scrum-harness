import type { OpenIssue } from './types.ts'

/**
 * Which open issues of `repos` that are not on the board count as off the board (B-OFF-BOARD). In a repository shared with other teams most open
 * issues are not the team's, so a team can narrow it. If absent, every open issue counts, as before.
 */
export type OffBoardScope =
  | { readonly scope: 'all' }
  /** Only what is on the board is watched; nothing is reported as off the board */
  | { readonly scope: 'none' }
  /** Only an open issue with one of these labels, or assigned to one of these logins, counts */
  | { readonly scope: 'filter'; readonly labels: readonly string[]; readonly assignees: readonly string[] }

const isNameList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((one) => typeof one === 'string' && one.trim() !== '')

/** undefined when the section is absent, null when it is of the wrong shape. A wrong shape must not fall back to `all`, which would flag every other team's issue. */
export function parseOffBoardScope(raw: unknown): OffBoardScope | null | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null) return null
  const { scope, labels, assignees } = raw as Record<string, unknown>
  if (scope === 'all' || scope === 'none') return labels === undefined && assignees === undefined ? { scope } : null
  if (scope !== 'filter') return null
  if ((labels !== undefined && !isNameList(labels)) || (assignees !== undefined && !isNameList(assignees))) return null
  const picked = { labels: (labels as readonly string[] | undefined) ?? [], assignees: (assignees as readonly string[] | undefined) ?? [] }
  return picked.labels.length + picked.assignees.length === 0 ? null : { scope, ...picked }
}

/** The open issues the scope watches. Pure. */
export function watchedIssues(openIssues: readonly OpenIssue[], scope: OffBoardScope | undefined): readonly OpenIssue[] {
  if (scope === undefined || scope.scope === 'all') return openIssues
  if (scope.scope === 'none') return []
  return openIssues.filter((issue) => (issue.labels ?? []).some((label) => scope.labels.includes(label)) || (issue.assignees ?? []).some((login) => scope.assignees.includes(login)))
}
