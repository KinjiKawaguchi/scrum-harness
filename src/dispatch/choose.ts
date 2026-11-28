import { countDoing } from '../board/commands.ts'
import { effectivePriority, itemsByRef, priorityRank } from '../board/priority.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import { dispatchOf, type Config } from '../config.ts'

/** 1: In Next and assigned to that person. 2: In Backlog and assigned to that person. 3: In Next and unassigned. */
export type Tier = 1 | 2 | 3

export type ChooseResult =
  | { readonly kind: 'chosen'; readonly item: BoardItem; readonly tier: Tier }
  | { readonly kind: 'none'; readonly reason: 'wip-limit' | 'no-candidate' }

/** Open issues (excluding those by excluded authors). Shared by the hand-over candidates and the way Epic children are counted */
export function isOpenIssue(item: BoardItem, config: Config): boolean {
  return item.kind === 'issue' && item.state === 'OPEN' && item.number !== null && !config.excludeAuthors.includes(item.author ?? '')
}

/** The tier of an issue that can be handed over. One that is blocked (has a blocked reason other than none) or is assigned to someone else is not handed over. */
function tierOf(item: BoardItem, member: string, config: Config): Tier | null {
  if (item.reason !== config.reasonNone) return null
  const isUnassigned = item.assignee === null || item.assignee === ''
  if (item.status === config.statuses.next && item.assignee === member) return 1
  if (item.status === config.statuses.backlog && item.assignee === member) return 2
  if (item.status === config.statuses.next && isUnassigned) return 3
  return null
}

/** An issue whose title starts with release/<number>. Release issues are cut out by hand, so they do not fit the base of the handover text and are excluded from hand-over. */
const RELEASE_TITLE = /^release\/\d+/

export function isReleaseIssue(item: BoardItem): boolean {
  return RELEASE_TITLE.test(item.title)
}

function hasSkipLabel(item: BoardItem, config: Config): boolean {
  const skip = dispatchOf(config).skipLabels
  return (item.labels ?? []).some((name) => skip.includes(name))
}

/** Per Epic, the number of people who have In Progress issues. An issue with no parent is lined up as 0 people. */
function peoplePerEpic(snapshot: Snapshot, config: Config): ReadonlyMap<string, number> {
  const doing = snapshot.items.filter((item) => isOpenIssue(item, config) && item.status === config.statuses.doing && item.epic)
  const people = new Map<string, Set<string>>()
  doing.forEach((item) => {
    const set = people.get(item.epic ?? '') ?? new Set<string>()
    set.add(item.assignee ?? '')
    people.set(item.epic ?? '', set)
  })
  return new Map([...people].map(([epic, set]) => [epic, set.size]))
}

/**
 * That person's In Progress issue that is not blocked (blocked reason is none). If there is one, no new issue is handed over, and the member is nudged to advance it.
 * If there are several, the one with the smallest number.
 */
export function ownDoingIssue(snapshot: Snapshot, member: string, config: Config): BoardItem | null {
  const own = snapshot.items.filter(
    (item) => isOpenIssue(item, config) && item.status === config.statuses.doing && item.assignee === member && item.reason === config.reasonNone,
  )
  return own.toSorted((a, b) => (a.number ?? 0) - (b.number ?? 0))[0] ?? null
}

/** How to compare the "order" field. Smaller comes first, and those with an empty field go last. */
function compare(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return a - b
}

/** The order of issues to hand over: tier, the effective priority (highest first; none after low, or not handed over when `dispatch.unprioritized` is `skip`; deferred is never handed over), the board's "order" (smaller first, none last), Epics with fewer people working, then number. */
export function chooseNext(snapshot: Snapshot, member: string, config: Config): ChooseResult {
  // In Progress is counted the same way as the guard before a write (checkGuard). In Progress by excluded authors (a different development party) is also counted
  if (countDoing(snapshot, config) >= config.wipLimit) return { kind: 'none', reason: 'wip-limit' }
  const load = peoplePerEpic(snapshot, config)
  const itemOf = itemsByRef(snapshot.items)
  const candidates = snapshot.items
    .filter((item) => isOpenIssue(item, config) && item.repo === config.defaultRepo && !hasSkipLabel(item, config) && !isReleaseIssue(item))
    .flatMap((item) => {
      const tier = tierOf(item, member, config)
      const priority = effectivePriority(item, itemOf)
      const isHeld = priority === 'deferred' || (priority === null && dispatchOf(config).unprioritized === 'skip')
      return tier === null || isHeld ? [] : [{ item, tier, rank: priorityRank(priority) }]
    })
  const sorted = candidates.toSorted(
    (a, b) =>
      a.tier - b.tier ||
      a.rank - b.rank ||
      compare(a.item.order, b.item.order) ||
      (load.get(a.item.epic ?? '') ?? 0) - (load.get(b.item.epic ?? '') ?? 0) ||
      (a.item.number ?? 0) - (b.item.number ?? 0),
  )
  const first = sorted[0]
  return first === undefined ? { kind: 'none', reason: 'no-candidate' } : { kind: 'chosen', item: first.item, tier: first.tier }
}

