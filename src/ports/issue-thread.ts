import type { BoardItem } from '../board/types.ts'

/** One issue comment. createdAt is ISO 8601. */
export type IssueComment = { readonly body: string; readonly createdAt: string; readonly url?: string }

/** The number and body of an open issue. */
export type IssueBody = { readonly number: number; readonly body: string }

/** Reads and writes an issue's comments and body. Throws on failure. */
export type IssueThread = {
  readonly comments: (item: BoardItem) => readonly IssueComment[]
  readonly openIssues: (repo: string) => readonly IssueBody[]
  /** Whether it is open now, and the body. Used to re-read just before writing */
  readonly read: (repo: string, number: number) => { readonly isOpen: boolean; readonly body: string }
  readonly writeBody: (repo: string, number: number, body: string) => void
  /** Adds a comment. The body is sent as data, never read as a file or a command. */
  readonly addComment: (repo: string, number: number, body: string) => void
}
