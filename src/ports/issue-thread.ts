import type { BoardItem } from '../board/types.ts'

/** One issue comment. createdAt is ISO 8601. */
export type IssueComment = { readonly body: string; readonly createdAt: string; readonly url?: string }

/** The number and body of an open issue. */
export type IssueBody = { readonly number: number; readonly body: string }

/** The part of an issue thread that reads and rewrites bodies. It serves one feature, linking PRs into the bodies of the issues they point to. */
export type BodyThread = {
  readonly openIssues: (repo: string) => readonly IssueBody[]
  /** Whether it is open now, and the body. Used to re-read just before writing */
  readonly read: (repo: string, number: number) => { readonly isOpen: boolean; readonly body: string }
  readonly writeBody: (repo: string, number: number, body: string) => void
}

/**
 * Reads and writes an issue's comments, and optionally its body. Throws on failure. An item is addressed by the item itself, so a tracker whose ids
 * are not a repository and a number can serve it. A tracker that cannot rewrite bodies leaves `openIssues`, `read`, and `writeBody` out (all three
 * or none), and then linking PRs into issues stays off.
 */
export type IssueThread = Partial<BodyThread> & {
  readonly comments: (item: BoardItem) => readonly IssueComment[]
  /** Adds a comment. The body is sent as data, never read as a file or a command. */
  readonly addComment: (item: BoardItem, body: string) => void
}
