import { label } from '../board/rules.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { alertsOf } from './config.ts'
import { isOpenIssue } from '../dispatch/choose.ts'
import type { MemberState } from '../team/types.ts'

/** The current state of one Epic that needs someone working on it (it has open children in Backlog, Next, or In Progress). */
export type EpicView = {
  /** "<repository name>#number" */
  readonly epic: string
  readonly title: string | null
  readonly openChildren: readonly BoardItem[]
  readonly doing: readonly BoardItem[]
  /** People who have In Progress children and are working now */
  readonly movers: readonly string[]
}

function groupByEpic(children: readonly BoardItem[]): ReadonlyMap<string, readonly BoardItem[]> {
  return children.reduce((acc, child) => new Map([...acc, [child.epic ?? '', [...(acc.get(child.epic ?? '') ?? []), child]]]), new Map<string, readonly BoardItem[]>())
}

/**
 * Among Epics with open children, those that need someone working on them. An Epic whose children are all in Backlog is also included (the shape with 0 people working).
 * If the children are only in Release or Done, the work is finished, so it is not counted.
 * If the Epic itself is on the board and is closed, or its author is in excludeAuthors (a different development party), or it has a label marking it as parked (alerts.parkedLabels), it is not counted
 * (the TechLead attaches the label, and the harness does not read the Epic's body). A child's parent is fetched when dispatch or alerts is enabled.
 */
export function epicViews(snapshot: Snapshot, members: readonly MemberState[], config: Config): readonly EpicView[] {
  const children = snapshot.items.filter((item) => isOpenIssue(item, config) && item.epic !== undefined && item.epic !== null && item.epic !== '')
  const workStatuses = [config.statuses.backlog, config.statuses.next, config.statuses.doing]
  const parked = alertsOf(config).parkedLabels
  const busy = new Set(members.filter((member) => member.state === 'busy').map((member) => member.name))
  return [...groupByEpic(children)].flatMap(([epic, openChildren]) => {
    const isLive = openChildren.some((child) => workStatuses.includes(child.status ?? ''))
    const self = snapshot.items.find((item) => item.kind === 'issue' && label(item) === epic)
    const isParked = (self?.labels ?? []).some((name) => parked.includes(name))
    const isExcludedAuthor = self !== undefined && config.excludeAuthors.includes(self.author ?? '')
    if (!isLive || isParked || isExcludedAuthor || (self !== undefined && self.state !== 'OPEN')) return []
    const doing = openChildren.filter((child) => child.status === config.statuses.doing)
    const movers = [...new Set(doing.flatMap((child) => (child.assignee !== null && busy.has(child.assignee) ? [child.assignee] : [])))]
    return [{ epic, title: self?.title ?? null, openChildren, doing, movers }]
  })
}

/** An Epic with nobody working on it. */
export function stalledViews(views: readonly EpicView[]): readonly EpicView[] {
  return views.filter((view) => view.movers.length === 0)
}

/** Keeps only Epics with nobody working on them right now, and carries over the time first seen from the earlier one. An Epic where work has started is dropped. */
export function advanceEpics(prev: Readonly<Record<string, string>>, views: readonly EpicView[], now: Date): Readonly<Record<string, string>> {
  return Object.fromEntries(stalledViews(views).map((view) => [view.epic, prev[view.epic] ?? now.toISOString()]))
}
