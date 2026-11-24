import type { SessionSignal } from '../team/types.ts'

/** The name and pid looked up from the session records. name is null if not found. */
export type SessionEntry = { readonly name: string | null; readonly pid: number | null }

/** An agent session's name and activity. */
export type SessionDirectory = {
  /** From session_id, looks up that session's name (the name shown in ListAgents) and pid */
  readonly find: (sessionId: string) => SessionEntry
  /** Activity signals of running sessions. Unreadable ones are dropped */
  readonly signals: () => readonly SessionSignal[]
}
