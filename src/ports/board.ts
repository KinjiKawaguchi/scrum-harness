import type { BoardCommand } from '../board/commands.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { StatusEvent } from '../sprint/effort.ts'
import type { Mark } from '../sprint/marks.ts'

/**
 * ボードを読む。読めなければ投げる。返ってきた中身が読めない形のときは FetchError (board/fetch-log.ts) を投げ、
 * 取得の生の出力を持たせる (refreshSnapshot が log に残す)。
 */
export type BoardSource = {
  /** ボードの項目と、ボードの外も含めた開いている issue。sprint の設定があれば、作業中の issue に Status の変化の記録を付ける */
  readonly fetchSnapshot: (now: Date) => Snapshot
  /** issue ごとの Status の変化を、ラベルをキーに読む。読めなければ null (記録が無いのと「期間が 0」を取り違えない) */
  readonly statusEvents: (items: readonly BoardItem[]) => ReadonlyMap<string, readonly StatusEvent[]> | null
}

/** ボードに書く。書けなければ投げる。 */
export type BoardWriter = {
  /** 担当と Status を書く手段があるか。無ければ、空いた部下に仕事を渡さない */
  readonly canAssign: boolean
  readonly assign: (item: BoardItem, member: string) => void
  readonly setStatus: (item: BoardItem, status: string) => void
  /** Whether a way to set the blocked reason exists. Without it, a decision cannot unblock an item. */
  readonly canSetReason: boolean
  readonly setReason: (item: BoardItem, reason: string) => void
  /** 超えた節目の数を書く。1 件の失敗で止めず、失敗したものの説明を返す */
  readonly writeOverrun: (marks: readonly Mark[]) => readonly string[]
}

/** エージェントのツールの呼び出しから、ボードへの書き込みを読み取る。 */
export type ActionReader = {
  /** Bash のコマンドの文字列から、ボードを書き換えるコマンドを読む */
  readonly commandsOf: (command: string) => readonly BoardCommand[]
  /** bin/scrum が node を起こすかを決める型 (grep -E)。post はツールの呼び出しの後、pre は書き込みの前に見る。pre が空なら確かめない */
  readonly shellPatterns: () => { readonly post: string; readonly pre: string }
}
