import { label } from '../board/rules.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { alertsOf } from './config.ts'
import { isOpenIssue } from '../dispatch/choose.ts'
import type { MemberState } from '../team/types.ts'

/** 動く人が要る Epic (バックログ、次にやる、作業中の開いた子を持つ) 1 つの、いまの様子。 */
export type EpicView = {
  /** "<リポジトリ名>#番号" */
  readonly epic: string
  readonly title: string | null
  readonly openChildren: readonly BoardItem[]
  readonly doing: readonly BoardItem[]
  /** 作業中の子を持ち、いま動いている人 */
  readonly movers: readonly string[]
}

function groupByEpic(children: readonly BoardItem[]): ReadonlyMap<string, readonly BoardItem[]> {
  return children.reduce((acc, child) => new Map([...acc, [child.epic ?? '', [...(acc.get(child.epic ?? '') ?? []), child]]]), new Map<string, readonly BoardItem[]>())
}

/**
 * 開いた子を持つ Epic のうち、動く人が要るもの。子がすべてバックログの Epic も入れる (動く人が 0 の形)。
 * 子がリリース待ちか完了だけなら、作業は済んでいるので数えない。
 * Epic 自身がボードにあって、閉じているか、作者が excludeAuthors (別の開発主体) か、積んである印のラベル (alerts.parkedLabels) が付いていれば数えない
 * (ラベルを付けるのは TechLead で、ハーネスは Epic の本文を読まない)。子の親は、dispatch か alerts が有効なときに取る。
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
    const movers = [...new Set(doing.flatMap((child) => (child.tanto !== null && busy.has(child.tanto) ? [child.tanto] : [])))]
    return [{ epic, title: self?.title ?? null, openChildren, doing, movers }]
  })
}

/** 動いている人がいない Epic。 */
export function stalledViews(views: readonly EpicView[]): readonly EpicView[] {
  return views.filter((view) => view.movers.length === 0)
}

/** いま動いている人がいない Epic だけを残し、最初に見た時刻は前のものを引き継ぐ。動き出した Epic は消える。 */
export function advanceEpics(prev: Readonly<Record<string, string>>, views: readonly EpicView[], now: Date): Readonly<Record<string, string>> {
  return Object.fromEntries(stalledViews(views).map((view) => [view.epic, prev[view.epic] ?? now.toISOString()]))
}
