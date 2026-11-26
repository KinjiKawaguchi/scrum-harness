import type { StatusEvent } from '../sprint/effort.ts'

export type ItemKind = 'issue' | 'pr' | 'draft'

export type ContentState = 'OPEN' | 'CLOSED' | 'MERGED'

/** One item of the board. Issues, PRs, and drafts are held in the same shape. */
export type BoardItem = {
  readonly itemId: string
  /**
   * The item's reference: its id and display label in findings, requests, and the team view (and the target of a decision). The GitHub adapter leaves it
   * out and the reference is `<repo>#<number>`; a board module for another tracker sets it. See docs/board-module.md for the rule it has to fit.
   */
  readonly ref?: string
  readonly kind: ItemKind
  readonly repo: string
  readonly number: number | null
  readonly title: string
  readonly state: ContentState | null
  readonly author: string | null
  readonly status: string | null
  readonly reason: string | null
  /** The date it started being blocked (YYYY-MM-DD) */
  readonly since: string | null
  readonly owner: string | null
  /** The team field's value (fetched only when the team is scoped). null when the item has none */
  readonly team?: string | null
  /** The work type field's value (fetched only when fields.workType is set). null when the item has none */
  readonly workType?: string | null
  readonly assignee: string | null
  /** Story points (fetched only when there is a sprint config) */
  readonly points?: number | null
  /** The number of exceeded checkpoints that the harness wrote to the board */
  readonly overrun?: number | null
  /** The record of Status changes. Fetched only for In Progress issues */
  readonly statusEvents?: readonly StatusEvent[]
  /** The hand-over order field (fetched only when there is a dispatch config). Smaller comes first */
  readonly order?: number | null
  /** The names of the issue's labels (fetched only when there is a dispatch config) */
  readonly labels?: readonly string[]
  /** The parent issue (Epic)'s "<repository name>#number" (fetched only when there is a dispatch config) */
  readonly epic?: string | null
}

/** Open issues of the target repositories, including those outside the board. */
export type OpenIssue = {
  /** As on a board item: the reference, when the adapter sets one */
  readonly ref?: string
  readonly repo: string
  readonly number: number
  readonly author: string | null
  /** The labels and assignees (read only when the off-board scope filters on them) */
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
}

export type Snapshot = {
  readonly fetchedAt: string
  readonly items: readonly BoardItem[]
  readonly openIssues: readonly OpenIssue[]
}
