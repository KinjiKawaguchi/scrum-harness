import type { SessionSignal } from '../team/types.ts'

/** The name and pid looked up from the session records. name is null if not found. */
export type SessionEntry = { readonly name: string | null; readonly pid: number | null }

/** How a session's last turn ended when it ended in an API error, as the session's own record says. */
export type TurnError = {
  /** The kind Claude Code records (`invalid_request`, `rate_limit`, ...) */
  readonly error: string
  /** The first line of the message it shows */
  readonly text: string
  /** When it happened (ISO 8601) */
  readonly at: string
  /** How many of the latest replies in a row were errors (the person's messages between them do not count) */
  readonly count: number
  /** Whether the error is the very last thing in the record: nothing came after it */
  readonly isLast: boolean
}

/** An agent session's name and activity. */
export type SessionDirectory = {
  /** From session_id, looks up that session's name (the name shown in ListAgents) and pid */
  readonly find: (sessionId: string) => SessionEntry
  /** Activity signals of running sessions. Unreadable ones are dropped */
  readonly signals: () => readonly SessionSignal[]
  /** The API error that ended the session's last turn, or null (its last reply was not one, or the record cannot be read). Absent when the adapter cannot tell */
  readonly turnError?: (sessionId: string) => TurnError | null
  /** The Claude Code version the session runs, as its record says; null when it cannot be told. Absent when the adapter cannot tell */
  readonly version?: (sessionId: string) => string | null
}
