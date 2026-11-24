export type ActivityState = 'busy' | 'idle' | 'waiting' | 'ended'

/** The activity record of one session. Built from both the hook heartbeat and Claude Code's session record. */
export type SessionSignal = {
  readonly sessionId: string
  readonly name: string
  readonly state: ActivityState
  /** The time it entered this state (ISO 8601) */
  readonly since: string
  readonly updatedAt: string
  readonly isAlive: boolean
  /** The time it took that name. When several sessions have the same name, the one that took it later is correct (same as ListAgents) */
  readonly nameSince: string | null
}

/** Activity grouped by name (member). Several sessions with the same name may be running. */
export type MemberState = {
  readonly name: string
  readonly state: 'busy' | 'idle' | 'waiting' | 'unknown'
  readonly since: string | null
}
