import type { SessionSignal } from '../team/types.ts'

/** セッションの記録から引いた名前と pid。見つからなければ name は null。 */
export type SessionEntry = { readonly name: string | null; readonly pid: number | null }

/** エージェントのセッションの名前と稼働。 */
export type SessionDirectory = {
  /** session_id から、そのセッションの名前 (ListAgents に出る名前) と pid を引く */
  readonly find: (sessionId: string) => SessionEntry
  /** 動いているセッションの稼働の信号。読めないものは捨てる */
  readonly signals: () => readonly SessionSignal[]
}
