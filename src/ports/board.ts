import type { BoardCommand } from '../board/commands.ts'
import type { BoardItem, OpenIssue, Snapshot } from '../board/types.ts'
import type { StatusEvent } from '../sprint/effort.ts'
import type { Mark } from '../sprint/marks.ts'

/** What a read of the tracker cost, and how much of the hour's allowance is left: GitHub's GraphQL points, which every harness, member, and daemon using one login spends from the same hour. */
export type GraphqlCost = { readonly cost: number; readonly remaining: number; readonly limit: number; readonly resetAt: string }

/** How much of the hour's GraphQL points is left, as the tracker says without charging for the question. */
export type GraphqlAllowance = { readonly remaining: number; readonly limit: number; readonly resetAt: string }

/**
 * The whole board as a read of the tracker gives it, before it is narrowed to a team: every item, and the open issues the scope watches. It is what teams that
 * use the same board can share, since it does not depend on the team.
 */
export type WholeBoard = { readonly items: readonly BoardItem[]; readonly openIssues: readonly OpenIssue[]; readonly cost?: GraphqlCost }

/** What a tracker says of an issue besides its Status: its labels, and the issues that still block it (its dependencies, in the same `<repo>#<number>` form). */
export type ItemRelations = { readonly labels: readonly string[]; readonly blockedBy: readonly string[] }

/**
 * Reads the board. Throws if it cannot be read. When the returned content is in an unreadable shape, throws FetchError (board/fetch-log.ts)
 * carrying the raw output of the fetch (refreshSnapshot leaves it in the log).
 */
export type BoardSource = {
  /** The board's items, and the open issues including those outside the board. If there is a sprint config, attaches the Status change record to In Progress issues */
  readonly fetchSnapshot: (now: Date) => Snapshot
  /** Reads each issue's Status changes, keyed by label. null if it cannot be read (so "no record" and "period is 0" are not confused) */
  readonly statusEvents: (items: readonly BoardItem[]) => ReadonlyMap<string, readonly StatusEvent[]> | null
  /**
   * Optional (a tracker may not be shared). Lets teams that read the same board read it once: `key` is the same for teams whose read is the same (the same
   * board, the same fields asked for, the same repositories), `readWhole` is that read, and `scope` narrows it to this team and attaches what is the team's own.
   * `fetchSnapshot` is `scope(readWhole())`.
   */
  readonly shared?: {
    readonly key: string
    readonly readWhole: (now: Date) => WholeBoard
    /** Optional (a tracker may not say). What is left of the hour's points; null when it cannot be asked. It costs nothing, and is asked only before a read that would be made. */
    readonly allowance?: () => GraphqlAllowance | null
    readonly scope: (whole: WholeBoard, now: Date) => Snapshot
  }
  /**
   * Optional (a tracker may have no dependencies). Reads the labels and the open blockers of the issues among `items`, keyed by label. An issue it could not read is not
   * in the map. Used by `scrum forecast`; throws if it cannot be asked.
   */
  readonly relations?: (items: readonly BoardItem[]) => ReadonlyMap<string, ItemRelations>
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
