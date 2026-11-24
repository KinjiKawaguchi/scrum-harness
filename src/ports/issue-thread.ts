import type { BoardItem } from '../board/types.ts'

/** issue のコメント 1 件。createdAt は ISO 8601。 */
export type IssueComment = { readonly body: string; readonly createdAt: string; readonly url?: string }

/** 開いている issue の番号と本文。 */
export type IssueBody = { readonly number: number; readonly body: string }

/** issue のコメントと本文を読み書きする。失敗すれば投げる。 */
export type IssueThread = {
  readonly comments: (item: BoardItem) => readonly IssueComment[]
  readonly openIssues: (repo: string) => readonly IssueBody[]
  /** いま開いているかと本文。書く直前に読み直すのに使う */
  readonly read: (repo: string, number: number) => { readonly isOpen: boolean; readonly body: string }
  readonly writeBody: (repo: string, number: number, body: string) => void
}
