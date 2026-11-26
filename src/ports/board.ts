import type { BoardCommand } from '../board/commands.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { StatusEvent } from '../sprint/effort.ts'
import type { Mark } from '../sprint/marks.ts'

/**
 * Reads the board. Throws if it cannot be read. When the returned content is in an unreadable shape, throws FetchError (board/fetch-log.ts)
 * carrying the raw output of the fetch (refreshSnapshot leaves it in the log).
 */
export type BoardSource = {
  /** The board's items, and the open issues including those outside the board. If there is a sprint config, attaches the Status change record to In Progress issues */
  readonly fetchSnapshot: (now: Date) => Snapshot
  /** Reads each issue's Status changes, keyed by label. null if it cannot be read (so "no record" and "period is 0" are not confused) */
  readonly statusEvents: (items: readonly BoardItem[]) => ReadonlyMap<string, readonly StatusEvent[]> | null
}

/** Writes to the board. Throws if it cannot write. */
export type BoardWriter = {
  /** Whether there is a means of writing the assignee and Status. If not, no work is handed to free members */
  readonly canAssign: boolean
  readonly assign: (item: BoardItem, member: string) => void
  readonly setStatus: (item: BoardItem, status: string) => void
  /** Whether a way to set the blocked reason exists. Without it, a decision cannot unblock an item. */
  readonly canSetReason: boolean
  readonly setReason: (item: BoardItem, reason: string) => void
  /** Optional (a tracker may not have it). Adds an issue to the board: Status Backlog when it has none, and this team's value in the team field when the board is shared. Not an error when it is already there. */
  readonly addToBoard?: (repo: string, number: number) => void
  /** Optional (a tracker may have no teams on its board). Sets the team field of an item, handing it to that team. */
  readonly setTeam?: (item: BoardItem, team: string) => void
  /** Writes the number of exceeded checkpoints. A single failure does not stop it; returns descriptions of the ones that failed */
  readonly writeOverrun: (marks: readonly Mark[]) => readonly string[]
}

/** One call of an agent's tool, as the hooks see it. `response` is there only after the call (PostToolUse). */
export type ToolCall = {
  /** The tool's name: `Bash`, or for a tool of an MCP server `mcp__<server>__<tool>` */
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
  readonly response?: unknown
}

/** Reads writes to the board from an agent's tool calls. */
export type ActionReader = {
  /** Reads, from one tool call (a Bash command, or an MCP tool call), the commands that rewrite the board. An empty list when the call does not touch the board */
  readonly actionsOf: (call: ToolCall) => readonly BoardCommand[]
  /** Patterns (grep -E) over the raw hook input that decide whether bin/scrum starts node. post is checked after a tool call, pre before a write. If pre is empty, nothing is checked. A pattern may name a tool (`mcp__<server>__<tool>`) */
  readonly shellPatterns: () => { readonly post: string; readonly pre: string }
}
