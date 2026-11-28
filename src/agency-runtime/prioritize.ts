import { label } from '../board/rules.ts'
import { patchWholeCopy, readWholeCopy } from '../board/shared.ts'
import { loadSnapshot, saveSnapshot } from '../board/snapshot.ts'
import type { BoardItem } from '../board/types.ts'
import type { Priority } from '../board/priority.ts'
import type { RuntimeDeps } from './handle.ts'
import { OWNER_ID } from './people.ts'
import { ticketsOf } from './tickets.ts'
import type { PrioritizeRequest, RuntimeError } from './types.ts'

const refusal = (status: number, message: string): RuntimeError => ({ status, message })

/** The items of the whole board as the tickets op reads them: the shared copy of every team's items, else the team's own copy. Null when neither is there. */
function boardItems(deps: RuntimeDeps): { readonly items: readonly BoardItem[]; readonly generatedAt: string } | null {
  const whole = readWholeCopy(deps.ports.board)
  if (whole !== null) return { items: whole.board.items, generatedAt: whole.fetchedAt }
  const own = deps.config.team === undefined ? loadSnapshot(deps.p) : null
  return own === null ? null : { items: own.items, generatedAt: own.fetchedAt }
}

/** The item with the new priority; the item is what it was when it is not the one written. */
const withPriority = (target: BoardItem, priority: Priority | null) => (item: BoardItem): BoardItem => (item.itemId === target.itemId ? { ...item, priority } : item)

/**
 * The prioritize op: sets the board's Priority of the ticket `target` names (a ticket's `prioritizeWith` in the `tickets` answer) to `priority`, or clears
 * it for `none`, with the harness's own login. Only a ticket the team lists is a target, so a team cannot write to another team's items by a reference it
 * made up; anything else is a 404. The node has verified the envelope and that the signer is the team's owner; a name for the decider, when it comes, must be the owner's.
 * The shared copy of the board and the team's own copy take the new value at once, so the next `tickets` answer and the dispatch see it.
 */
export function prioritize(request: PrioritizeRequest, deps: RuntimeDeps): { readonly result: Record<string, never> } | { readonly error: RuntimeError } {
  const { p, config, ports } = deps
  const unknown = `no such ticket: ${request.target}`
  if (request.byParticipant !== undefined && request.byParticipant !== OWNER_ID) return { error: refusal(404, unknown) }
  const setPriority = ports.writer.setPriority
  if (setPriority === undefined) return { error: refusal(503, 'this board cannot take a priority from here') }
  const board = boardItems(deps)
  if (board === null) return { error: refusal(503, 'the board has not been read yet') }
  const listed = ticketsOf(board.items, config, request.org, request.team, board.generatedAt, true)
  if ('status' in listed) return { error: listed }
  const found = [...listed.epics, ...listed.epics.flatMap((epic) => epic.children), ...listed.withoutEpic].find((ticket) => ticket.prioritizeWith === request.target)
  const item = found === undefined ? undefined : board.items.find((one) => label(one) === found.ref)
  if (item === undefined) return { error: refusal(404, unknown) }
  const priority = request.priority === 'none' ? null : request.priority
  if ((item.priority ?? null) !== priority) {
    try {
      setPriority(item, priority)
    } catch (error) {
      return { error: refusal(503, `could not set the priority: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`) }
    }
  }
  const change = withPriority(item, priority)
  patchWholeCopy(ports.board, change)
  const own = loadSnapshot(p)
  if (own !== null) saveSnapshot(p, { ...own, items: own.items.map(change) })
  return { result: {} }
}
