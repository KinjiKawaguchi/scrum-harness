export type ActivityState = 'busy' | 'idle' | 'waiting' | 'ended'

/** 1セッションの稼働の記録。フックの心拍と Claude Code のセッションの記録の両方から作る。 */
export type SessionSignal = {
  readonly sessionId: string
  readonly name: string
  readonly state: ActivityState
  /** この状態に入った時刻 (ISO 8601) */
  readonly since: string
  readonly updatedAt: string
  readonly isAlive: boolean
  /** その名前を取った時刻。同じ名前のセッションが複数あるときは、後から取ったほうが正 (ListAgents と同じ) */
  readonly nameSince: string | null
}

/** 名前 (部下) ごとにまとめた稼働。同じ名前のセッションが複数動いていることがある。 */
export type MemberState = {
  readonly name: string
  readonly state: 'busy' | 'idle' | 'waiting' | 'unknown'
  readonly since: string | null
}
