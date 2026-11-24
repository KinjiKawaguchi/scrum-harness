import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import type { Config } from '../config.ts'
import { runtimeOf } from './config.ts'
import type { BlockedReason, WorkItem, WorkStatus } from './types.ts'

/** The board status names, in Agency's fixed set. A status the configuration does not name is not a work item. */
export function workStatusOf(item: BoardItem, config: Config): WorkStatus | null {
  const names: readonly (readonly [string, WorkStatus])[] = [
    [config.statuses.backlog, 'backlog'],
    [config.statuses.next, 'next'],
    [config.statuses.doing, 'inProgress'],
    [config.statuses.release, 'release'],
    [config.statuses.done, 'done'],
  ]
  return names.find(([name]) => name === item.status)?.[1] ?? null
}

/** The blocked reason in Agency's set, or null when the item is not blocked. An unlisted reason is `external`. */
export function blockedReasonOf(item: BoardItem, config: Config): BlockedReason | null {
  if (item.reason === null || item.reason === config.reasonNone) return null
  if (item.reason === config.reasonJudge) return 'needsDecision'
  const names = runtimeOf(config).blockedReasons ?? {}
  if (item.reason === names.waitingOnPrevious) return 'waitingOnPrevious'
  if (item.reason === names.timeOrEquipment) return 'timeOrEquipment'
  return 'external'
}

export const isFinished = (status: WorkStatus | null): boolean => status === 'release' || status === 'done'

/** The date a block began. A block without a start date counts from the day the board was read. */
export const blockedSince = (item: BoardItem, fetchedAt: string): string =>
  item.since !== null && /^\d{4}-\d{2}-\d{2}$/.test(item.since) ? item.since : fetchedAt.slice(0, 10)

/** Open issues of the team, without the parents of other items (those are reported as epics). */
export function workItems(items: readonly BoardItem[], config: Config, fetchedAt: string, epicRefs: ReadonlySet<string>): readonly WorkItem[] {
  return items
    .filter((item) => item.kind === 'issue' && item.state === 'OPEN' && !config.excludeAuthors.includes(item.author ?? '') && !epicRefs.has(label(item)))
    .flatMap((item): readonly WorkItem[] => {
      const status = workStatusOf(item, config)
      if (status === null) return []
      const reason = blockedReasonOf(item, config)
      const hasPoints = typeof item.points === 'number' && Number.isInteger(item.points) && item.points >= 0
      return [
        {
          ref: label(item),
          title: item.title,
          status,
          ...(item.assignee === null || item.assignee === '' ? {} : { assignee: item.assignee }),
          ...(reason === null ? {} : { blocked: { reason, since: blockedSince(item, fetchedAt) } }),
          ...(item.epic === null || item.epic === undefined ? {} : { epic: item.epic }),
          ...(hasPoints ? { points: item.points as number } : {}),
        },
      ]
    })
}
