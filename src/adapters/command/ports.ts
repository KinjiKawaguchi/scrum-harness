import type { AdapterCommandConfig, CommandCapability } from '../../adapter-module.ts'
import { label } from '../../board/rules.ts'
import { snapshotProblems } from '../../board/snapshot-check.ts'
import type { BoardItem, Snapshot } from '../../board/types.ts'
import type { Config } from '../../config.ts'
import type { BoardWriter, IssueComment, IssueThread } from '../../ports/index.ts'
import type { StatusEvent } from '../../sprint/effort.ts'
import { bashActionReader } from '../github/action-reader.ts'
import { withCheckedRefs, type ModulePorts } from '../module/load.ts'
import { callBoardProgram } from './call.ts'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The snapshot the program answered, with the time of the read filled in when it gave none. Not checked here: see `commandPorts`. */
function rawSnapshotOf(result: unknown, now: Date): Snapshot {
  if (!isObject(result)) throw new Error('the board program must answer a snapshot: an object with items and openIssues')
  return { ...result, fetchedAt: typeof result.fetchedAt === 'string' ? result.fetchedAt : now.toISOString() } as unknown as Snapshot
}

/** Throws, naming the problems, when a snapshot does not fit the contract, so the core never sees a shape it does not expect. */
function assertSnapshotFits(snapshot: Snapshot, config: Config): Snapshot {
  const problems = snapshotProblems(snapshot, config, 5)
  if (problems.length > 0) throw new Error(`the board program returned a snapshot that does not fit the contract: ${problems.join('; ')}`)
  return snapshot
}

/** ref -> Status changes, or null when the program cannot say (the same meaning as the port's null). A malformed answer is null, not a guess. */
function statusEventsOf(result: unknown): ReadonlyMap<string, readonly StatusEvent[]> | null {
  if (!isObject(result)) return null
  const isEvent = (one: unknown): one is StatusEvent => isObject(one) && typeof one.at === 'string' && !Number.isNaN(Date.parse(one.at)) && (one.status === null || typeof one.status === 'string')
  const entries = Object.entries(result)
  return entries.every(([, events]) => Array.isArray(events) && events.every(isEvent)) ? new Map(entries as [string, StatusEvent[]][]) : null
}

const isComment = (one: unknown): one is IssueComment => isObject(one) && typeof one.body === 'string' && typeof one.createdAt === 'string' && !Number.isNaN(Date.parse(one.createdAt)) && (one.url === undefined || typeof one.url === 'string')

/** The item as a request names it: its reference first, and the ids the board record has. */
const itemOf = (item: BoardItem) => ({ ref: label(item), itemId: item.itemId, repo: item.repo, number: item.number })

function unavailable(what: string, capability: CommandCapability): () => never {
  return () => {
    throw new Error(`${what} is not available: the board program does not list "${capability}" in its capabilities`)
  }
}

/** The writer of a program. Without `write` it still replaces the GitHub writer (a team on another tracker must never write a GitHub board), with the flags off and every write refusing. */
function writerOf(spec: AdapterCommandConfig): BoardWriter {
  const can = (capability: CommandCapability): boolean => spec.capabilities.includes(capability)
  const set = (item: { readonly ref: string; readonly itemId: string }, field: string, value: string | number | null): void => void callBoardProgram(spec, { op: 'set', item, field, value })
  const write = can('write')
  return {
    canAssign: write,
    canSetReason: write,
    assign: write ? (item, member) => set(itemOf(item), 'assignee', member) : unavailable('assigning', 'write'),
    setStatus: write ? (item, status) => set(itemOf(item), 'status', status) : unavailable('setting a Status', 'write'),
    setReason: write ? (item, reason) => set(itemOf(item), 'reason', reason) : unavailable('setting a blocked reason', 'write'),
    writeOverrun: (marks) => {
      if (marks.length === 0) return []
      if (!write) return [`writing the overrun is not available: the board program does not list "write" in its capabilities`]
      return marks.flatMap((mark) => {
        try {
          set({ ref: mark.label, itemId: mark.itemId }, 'overrun', mark.value)
          return []
        } catch (error) {
          return [`${mark.label}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`]
        }
      })
    },
    ...(can('add') ? { addToBoard: (repo: string, number: number) => void callBoardProgram(spec, { op: 'add', repo, number }) } : {}),
    ...(can('team') ? { setTeam: (item: BoardItem, team: string) => set(itemOf(item), 'team', team) } : {}),
  }
}

/** The comments of a program. Without `comments` it still replaces the GitHub thread, with no comments and a refusal to add one. It has no body side, so linking PRs into issues stays off. */
function threadOf(spec: AdapterCommandConfig): IssueThread {
  if (!spec.capabilities.includes('comments')) return { comments: () => [], addComment: unavailable('commenting', 'comments') }
  return {
    comments: (item) => {
      const result = callBoardProgram(spec, { op: 'comments', item: itemOf(item) })
      if (!Array.isArray(result) || !result.every(isComment)) throw new Error('the board program must answer the comments as a list of { body, createdAt, url? }')
      return result
    },
    addComment: (item, body) => void callBoardProgram(spec, { op: 'comment', item: itemOf(item), body }),
  }
}

/** The ports of the program as they are, without checking what it answers (`scrum adapter check` checks it and lists every problem). */
export function rawCommandPorts(spec: AdapterCommandConfig, config: Config): ModulePorts {
  return {
    board: {
      fetchSnapshot: (now) => rawSnapshotOf(callBoardProgram(spec, { op: 'snapshot', now: now.toISOString() }), now),
      statusEvents: (items) => {
        try {
          return statusEventsOf(callBoardProgram(spec, { op: 'statusEvents', items: items.map((item) => label(item)) }))
        } catch {
          return null
        }
      },
    },
    writer: writerOf(spec),
    issues: threadOf(spec),
    actions: bashActionReader(config),
  }
}

/**
 * The ports of a team whose board is a program that speaks `scrum-board/1`. Reading is always there; what else the program can do is named in its
 * `capabilities`, and the harness offers (and calls) only that. The agents' own board writes are read the way they are for GitHub: from the
 * `scripts` named in the configuration. Every snapshot is checked before the core sees it.
 */
export function commandPorts(spec: AdapterCommandConfig, config: Config): ModulePorts {
  const raw = rawCommandPorts(spec, config)
  const board = raw.board
  if (board === undefined) return raw
  return withCheckedRefs({ ...raw, board: { ...board, fetchSnapshot: (now) => assertSnapshotFits(board.fetchSnapshot(now), config) } })
}
