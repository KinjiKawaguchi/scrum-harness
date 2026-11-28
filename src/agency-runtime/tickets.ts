import { effectivePriority, itemsByRef, priorityRank } from '../board/priority.ts'
import { label } from '../board/rules.ts'
import { readWholeCopy } from '../board/shared.ts'
import { isRefreshDue, loadSnapshot } from '../board/snapshot.ts'
import { isOwn } from '../board/team-scope.ts'
import type { BoardItem } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { RuntimeDeps } from './handle.ts'
import type { RuntimeError, Ticket, Tickets, TicketsRequest, WorkStatus } from './types.ts'
import { workStatusOf } from './work.ts'

/** The limits of an answer, as the contract has them: a node refuses an answer beyond them whole. */
export const MOST_EPICS = 500
export const MOST_TICKETS = 5000
export const MOST_PULL_REQUESTS = 50
export const MOST_TEXT = 200

/** At most `MOST_TEXT` characters (code points, so no character is cut in two). */
const clip = (text: string): string => (text.length <= MOST_TEXT ? text : [...text].slice(0, MOST_TEXT).join(''))

const compareRefs = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true })

/** An item of the board that is a ticket: an issue (not a pull request or a draft) that the team's configuration does not leave out. */
const isTicket = (item: BoardItem, config: Config): boolean => item.kind === 'issue' && item.number !== null && !config.excludeAuthors.includes(item.author ?? '')

function statusOf(item: BoardItem, config: Config): WorkStatus {
  if (item.state === 'CLOSED') return 'done'
  return workStatusOf(item, config) ?? 'backlog'
}

/** The open pull requests that name the ticket as the issue they close, as GitHub names them. */
function pullRequestsOf(ref: string, openByIssue: ReadonlyMap<string, readonly BoardItem[]>): Ticket['pullRequests'] {
  return (openByIssue.get(ref) ?? [])
    .flatMap((pr) => (pr.number === null || pr.number < 1 || !/^[^/\s]+\/[^/\s]+$/.test(pr.repo) ? [] : [{ repo: pr.repo, number: pr.number, title: clip(pr.title) }]))
    .toSorted((a, b) => a.repo.localeCompare(b.repo, 'en') || a.number - b.number)
    .filter((pr, index, all) => index === 0 || pr.repo !== all[index - 1]?.repo || pr.number !== all[index - 1]?.number)
    .slice(0, MOST_PULL_REQUESTS)
}

/** The tickets the team answers for, from the whole board (every team's items): the epics whose Team is the team's with every child, and the team's tickets in no epic. */
export function ticketsOf(items: readonly BoardItem[], config: Config, org: string, team: string, generatedAt: string): Tickets | RuntimeError {
  const itemOf = itemsByRef(items)
  const tickets = items.filter((item) => isTicket(item, config))
  const refs = new Set(tickets.map(label))
  /** The epic at the top of an item's chain of parents that are on the board, or null when it has no parent on the board. */
  const rootOf = (item: BoardItem): string | null => {
    const chain: string[] = []
    for (let parent = item.epic; parent !== undefined && parent !== null && refs.has(parent) && !chain.includes(parent); parent = itemOf(parent)?.epic) chain.push(parent)
    return chain.at(-1) ?? null
  }
  const openByIssue = Map.groupBy(
    items.filter((item) => item.kind === 'pr' && item.state === 'OPEN' && item.closes !== undefined),
    (item) => item.closes as string,
  )
  const ticketOf = (item: BoardItem): Ticket => {
    const ref = label(item)
    const priority = item.priority ?? undefined
    const effective = effectivePriority(item, itemOf) ?? undefined
    return {
      ref,
      title: clip(item.title),
      status: statusOf(item, config),
      ...(item.team === undefined || item.team === null || item.team === '' ? {} : { team: clip(item.team) }),
      ...(item.assignee === null || item.assignee === '' ? {} : { assignee: clip(item.assignee) }),
      ...(typeof item.points === 'number' && Number.isInteger(item.points) && item.points >= 0 ? { points: item.points } : {}),
      ...(priority === undefined ? {} : { priority }),
      ...(effective === undefined ? {} : { effectivePriority: effective }),
      pullRequests: pullRequestsOf(ref, openByIssue),
    }
  }
  const byOrder = (a: Ticket, b: Ticket): number => priorityRank(a.effectivePriority ?? null) - priorityRank(b.effectivePriority ?? null) || compareRefs(a.ref, b.ref)
  const owns = (item: BoardItem): boolean => config.team === undefined || isOwn(item, config.team)
  const children = Map.groupBy(
    tickets.filter((item) => rootOf(item) !== null),
    (item) => rootOf(item) as string,
  )
  // An epic is a ticket that others name as their parent, or that says it has sub-issues, and is itself under no epic on the board; the team whose Team it has answers for it.
  const epicRefs = new Set([...children.keys(), ...tickets.filter((item) => (item.subIssues ?? 0) > 0 && rootOf(item) === null).map(label)])
  const epics = [...epicRefs]
    .flatMap((ref) => {
      const epic = itemOf(ref)
      return epic !== undefined && owns(epic) ? [{ ...ticketOf(epic), children: (children.get(ref) ?? []).map(ticketOf).toSorted(byOrder) }] : []
    })
    .toSorted(byOrder)
  const withoutEpic = tickets.filter((item) => owns(item) && rootOf(item) === null && !epicRefs.has(label(item))).map(ticketOf).toSorted(byOrder)
  const count = epics.reduce((sum, epic) => sum + 1 + epic.children.length, withoutEpic.length)
  if (epics.length > MOST_EPICS) return { status: 503, message: `the team has ${epics.length} epics, more than the ${MOST_EPICS} an answer may list` }
  if (count > MOST_TICKETS) return { status: 503, message: `the team has ${count} tickets, more than the ${MOST_TICKETS} an answer may list` }
  return { org, team, generatedAt, epics, withoutEpic }
}

/**
 * The tickets op. It reads the whole board as the teams of the machine last read it (so a child of another team is in its epic), and never the tracker: when
 * a refresh is due it starts one in the background, as `view` does. A team that is alone on its board needs no shared copy, since its own copy is the whole board.
 */
export function tickets(request: TicketsRequest, deps: RuntimeDeps): { readonly result: Tickets } | { readonly error: RuntimeError } {
  const { p, config, now, ports } = deps
  if (isRefreshDue(p, config, now)) deps.spawnRefresh()
  const whole = readWholeCopy(ports.board)
  if (whole === null && config.team !== undefined) return { error: { status: 503, message: 'the whole board has not been read yet (the teams of this machine share one copy of it); a refresh was started' } }
  const snapshot = whole === null ? loadSnapshot(p) : null
  if (whole === null && snapshot === null) return { error: { status: 503, message: 'the board has not been read yet; a refresh was started' } }
  const items = whole === null ? (snapshot?.items ?? []) : whole.board.items
  const generatedAt = new Date(whole === null ? (snapshot?.fetchedAt ?? now.toISOString()) : whole.fetchedAt).toISOString()
  const answer = ticketsOf(items, config, request.org, request.team, generatedAt)
  return 'status' in answer ? { error: answer } : { result: answer }
}
