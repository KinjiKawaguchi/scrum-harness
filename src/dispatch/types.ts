import type { ProgressToken } from './progress.ts'

/**
 * 空いた部下に渡した仕事の記録。渡した順に、1行1件で残す。
 * kind が nudge のものは、新しい issue でなく、自分の作業中の issue を進めるよう促した記録 (無ければ dispatch)。
 */
export type DispatchRecord = {
  readonly kind?: 'dispatch' | 'nudge'
  readonly at: string
  readonly member: string
  /** "<リポジトリ名>#番号" */
  readonly label: string
  readonly title: string
  /** 渡したときに、issue に紐づけたブランチ (用意したときだけ) */
  readonly branch?: string
  /** 促しを送った時点の、issue の作業の印。次の促しの前に、これと比べて、作業が進んだかを見る (促しだけに付く) */
  readonly progress?: ProgressToken
}
