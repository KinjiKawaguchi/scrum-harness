import type { BoardItem } from '../board/types.ts'
import type { OpenPr } from '../links/extract.ts'

/** A branch linked to an issue. isNew is whether it was just created (false if a linked branch already existed). */
export type LinkedBranch = { readonly name: string; readonly isNew: boolean }

/** The result put in the handed-over work's text. failed means preparing was attempted and failed. */
export type LinkOutcome = LinkedBranch | 'failed' | null

/** PRs and branches. The code host can be chosen separately from the board's host. */
export type CodeHost = {
  /** Open PRs. Throws if unreadable */
  readonly openPullRequests: (repo: string) => readonly OpenPr[]
  /** Labels of the issues that a PR body touches ("<repository name>#number"). null if the PR cannot be read */
  readonly referencedIssues: (prLabel: string, repo: string) => readonly string[] | null
  /** Prepares a linked branch for the issue being handed over. null if there is no config. Throws on failure */
  readonly prepareBranch: (item: BoardItem) => LinkedBranch | null
  /** A marker for seeing whether work on an issue progressed (comments, branch, PR). null if unreadable, or throws */
  readonly activity: (item: BoardItem) => string | null
}
