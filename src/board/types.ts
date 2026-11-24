import type { StatusEvent } from '../sprint/effort.ts'

export type ItemKind = 'issue' | 'pr' | 'draft'

export type ContentState = 'OPEN' | 'CLOSED' | 'MERGED'

/** ボードの1項目。issue・PR・下書きを同じ形で持つ。 */
export type BoardItem = {
  readonly itemId: string
  readonly kind: ItemKind
  readonly repo: string
  readonly number: number | null
  readonly title: string
  readonly state: ContentState | null
  readonly author: string | null
  readonly status: string | null
  readonly reason: string | null
  /** 止まり始めた日 (YYYY-MM-DD) */
  readonly since: string | null
  readonly owner: string | null
  readonly assignee: string | null
  /** ストーリーポイント (sprint の設定があるときだけ取る) */
  readonly points?: number | null
  /** ハーネスがボードに書いた、超えた節目の数 */
  readonly overrun?: number | null
  /** Status の変化の記録。作業中の issue のときだけ取る */
  readonly statusEvents?: readonly StatusEvent[]
  /** 渡す順の欄 (dispatch の設定があるときだけ取る)。小さいほど先 */
  readonly order?: number | null
  /** issue のラベルの名前 (dispatch の設定があるときだけ取る) */
  readonly labels?: readonly string[]
  /** 親の issue (Epic) の "<リポジトリ名>#番号" (dispatch の設定があるときだけ取る) */
  readonly epic?: string | null
}

/** ボードの外も含めた、対象のリポジトリの開いている issue。 */
export type OpenIssue = {
  readonly repo: string
  readonly number: number
  readonly author: string | null
}

export type Snapshot = {
  readonly fetchedAt: string
  readonly items: readonly BoardItem[]
  readonly openIssues: readonly OpenIssue[]
}
