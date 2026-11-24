import { countDoing } from '../board/commands.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import { dispatchOf, type Config } from '../config.ts'

/** 1: 次にやるで担当がその人。2: バックログで担当がその人。3: 担当なしの次にやる。 */
export type Tier = 1 | 2 | 3

export type ChooseResult =
  | { readonly kind: 'chosen'; readonly item: BoardItem; readonly tier: Tier }
  | { readonly kind: 'none'; readonly reason: 'wip-limit' | 'no-candidate' }

/** 開いている issue (除く作者のものを除く)。渡す候補と、Epic の子の数え方で共通 */
export function isOpenIssue(item: BoardItem, config: Config): boolean {
  return item.kind === 'issue' && item.state === 'OPEN' && item.number !== null && !config.excludeAuthors.includes(item.author ?? '')
}

/** 渡せる issue の区分。止まっている (理由がなし以外) もの、担当が他の人のものは渡さない。 */
function tierOf(item: BoardItem, member: string, config: Config): Tier | null {
  if (item.reason !== config.reasonNone) return null
  const isUnassigned = item.assignee === null || item.assignee === ''
  if (item.status === config.statuses.next && item.assignee === member) return 1
  if (item.status === config.statuses.backlog && item.assignee === member) return 2
  if (item.status === config.statuses.next && isUnassigned) return 3
  return null
}

/** 題が release/<番号> で始まる issue。リリースの issue は人が手で切り出すので、渡す文の土台と合わず、渡す対象から外す。 */
const RELEASE_TITLE = /^release\/\d+/

export function isReleaseIssue(item: BoardItem): boolean {
  return RELEASE_TITLE.test(item.title)
}

function hasSkipLabel(item: BoardItem, config: Config): boolean {
  const skip = dispatchOf(config).skipLabels
  return (item.labels ?? []).some((name) => skip.includes(name))
}

/** Epic ごとに、作業中の issue を持つ人の数。親の無い issue は 0 人として並べる。 */
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
 * その人の作業中で、止まっていない (理由がなし) issue。あれば、新しい issue は渡さず、これを進めるよう促す。
 * 複数あれば番号の小さいもの。
 */
export function ownDoingIssue(snapshot: Snapshot, member: string, config: Config): BoardItem | null {
  const own = snapshot.items.filter(
    (item) => isOpenIssue(item, config) && item.status === config.statuses.doing && item.assignee === member && item.reason === config.reasonNone,
  )
  return own.toSorted((a, b) => (a.number ?? 0) - (b.number ?? 0))[0] ?? null
}

/** 「順」の比べ方。小さいほど先で、欄が空のものは最後。 */
function compare(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return a - b
}

/** 渡す issue の並び。区分、ボードの「順」(小さいほど先、無ければ最後)、動いている人の少ない Epic、番号の順。 */
export function chooseNext(snapshot: Snapshot, member: string, config: Config): ChooseResult {
  // 作業中の数え方は、書き込みの前の守り (checkGuard) と同じ。除く作者 (別の開発主体) の作業中も数える
  if (countDoing(snapshot, config) >= config.wipLimit) return { kind: 'none', reason: 'wip-limit' }
  const load = peoplePerEpic(snapshot, config)
  const candidates = snapshot.items
    .filter((item) => isOpenIssue(item, config) && item.repo === config.defaultRepo && !hasSkipLabel(item, config) && !isReleaseIssue(item))
    .flatMap((item) => {
      const tier = tierOf(item, member, config)
      return tier === null ? [] : [{ item, tier }]
    })
  const sorted = candidates.toSorted(
    (a, b) =>
      a.tier - b.tier ||
      compare(a.item.order, b.item.order) ||
      (load.get(a.item.epic ?? '') ?? 0) - (load.get(b.item.epic ?? '') ?? 0) ||
      (a.item.number ?? 0) - (b.item.number ?? 0),
  )
  const first = sorted[0]
  return first === undefined ? { kind: 'none', reason: 'no-candidate' } : { kind: 'chosen', item: first.item, tier: first.tier }
}

