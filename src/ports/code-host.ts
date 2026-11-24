import type { BoardItem } from '../board/types.ts'
import type { OpenPr } from '../links/extract.ts'

/** issue に紐づいたブランチ。isNew は、いま作ったか (すでに紐づいたものがあれば false)。 */
export type LinkedBranch = { readonly name: string; readonly isNew: boolean }

/** 渡した仕事の文面に載せる結果。failed は、用意しようとして失敗したこと。 */
export type LinkOutcome = LinkedBranch | 'failed' | null

/** PR とブランチ。コードの置き場は、ボードの置き場と別に選べる。 */
export type CodeHost = {
  /** 開いている PR。読めなければ投げる */
  readonly openPullRequests: (repo: string) => readonly OpenPr[]
  /** PR の本文が触れている issue のラベル ("<リポジトリ名>#番号")。PR を読めなければ null */
  readonly referencedIssues: (prLabel: string, repo: string) => readonly string[] | null
  /** 渡す issue に、紐づいたブランチを用意する。設定が無ければ null。失敗すれば投げる */
  readonly prepareBranch: (item: BoardItem) => LinkedBranch | null
  /** issue の作業が進んだかを見る印 (コメント、ブランチ、PR)。読めなければ null か、投げる */
  readonly activity: (item: BoardItem) => string | null
}
