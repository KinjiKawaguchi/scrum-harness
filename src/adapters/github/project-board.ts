import type { Config } from '../../config.ts'
import type { BoardSource } from '../../ports/index.ts'
import { FetchError } from '../../board/fetch-log.ts'
import type { BoardItem, OpenIssue, Snapshot } from '../../board/types.ts'
import type { GhRun } from './gh.ts'
import { itemNodeSelection, normalizeNodes, type RawNode } from './item-node.ts'
import { readMissingItems } from './off-board.ts'
import { statusEventsFor, withStatusHistory } from './status-history.ts'

export function itemsQuery(config: Config): string {
  return `query($projectId:ID!, $endCursor:String){ node(id:$projectId){ ... on ProjectV2 { items(first:100, after:$endCursor){
    totalCount pageInfo{ hasNextPage endCursor } nodes{ ${itemNodeSelection(config)} } } } } }`
}


type RawPage = {
  readonly data?: { readonly node?: { readonly items?: { readonly totalCount?: unknown; readonly nodes?: unknown } | null } | null } | null
}

/** 取れた件数が総数より少ないとき、取得中にボードから消えた項目の分として許す件数と割合。 */
const MISSING_TOLERANCE_COUNT = 3
const MISSING_TOLERANCE_RATIO = 0.01

/** issue と PR の項目のうち、中身 (番号) が読めないものがこの割合を超えたら、取得に失敗したとみなす。 */
const UNREADABLE_LIMIT = 0.5
/** 割合で判じるのに足りる件数。これより少ないボードでは割合を見ない。 */
const UNREADABLE_MIN_ITEMS = 10

/**
 * 取得に失敗した結果は、例外を出さずに空や中身の無い項目として返ることがある。そのまま控えに書くと、
 * 開いている issue がすべて「ボードに無い」(B-OFF-BOARD) と出るので、書く前に落とす。
 */
function assertReadable(items: readonly BoardItem[], total: number): void {
  const allowedMissing = Math.max(MISSING_TOLERANCE_COUNT, Math.floor(total * MISSING_TOLERANCE_RATIO))
  if (items.length < total - allowedMissing) {
    throw new Error(`Only ${items.length} of ${total} board items were fetched. Paging may have been cut short, so the board copy is not rewritten`)
  }
  if (items.length === 0) throw new Error('The board has 0 items. The fetch may have failed, so the board copy is not rewritten')
  const contentItems = items.filter((item) => item.kind !== 'draft')
  const unreadable = contentItems.filter((item) => item.number === null).length
  if (contentItems.length >= UNREADABLE_MIN_ITEMS && unreadable / contentItems.length > UNREADABLE_LIMIT) {
    throw new Error(`The content of ${unreadable} of ${contentItems.length} issue and PR items cannot be read. Suspect the token's permissions. The board copy is not rewritten`)
  }
}

/** `gh api graphql --paginate --slurp` の出力から、ボードの項目を取り出す。形が違うか、項目が読めなければ投げる。 */
export function parseItemPages(output: string): readonly BoardItem[] {
  const pages: unknown = JSON.parse(output)
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error(`The board fetch result is not an array of pages: ${output.slice(0, 200)}`)
  }
  const total = (pages[0] as RawPage | undefined)?.data?.node?.items?.totalCount
  if (typeof total !== 'number') throw new Error(`The board fetch result has no item total (totalCount): ${JSON.stringify(pages[0]).slice(0, 200)}`)
  const nodes = (pages as readonly RawPage[]).flatMap((page, index): readonly RawNode[] => {
    const found = page?.data?.node?.items?.nodes
    if (!Array.isArray(found)) {
      throw new Error(`Page ${index + 1} of the board fetch result has no list of items: ${JSON.stringify(page).slice(0, 200)}`)
    }
    return found as readonly RawNode[]
  })
  const items = normalizeNodes(nodes)
  assertReadable(items, total)
  return items
}

/** 1ページ100件で2ポイント程度。1000件のボードなら全件で20ポイント、十数秒かかる。 */
function parseOrCarry(raw: string): readonly BoardItem[] {
  try {
    return parseItemPages(raw)
  } catch (error) {
    throw new FetchError(error instanceof Error ? error.message : String(error), raw)
  }
}

/** 設定のリポジトリごとに、開いている issue か PR の番号と作者を読む。 */
function listOpen(run: GhRun, kind: 'issue' | 'pr', config: Config): readonly OpenIssue[] {
  return config.repos.flatMap((repo): readonly OpenIssue[] => {
    const raw = JSON.parse(run([kind, 'list', '-R', repo, '--state', 'open', '--limit', '1000', '--json', 'number,author']))
    return (raw as readonly { number: number; author?: { login?: string } }[]).map((one) => ({
      repo,
      number: one.number,
      author: one.author?.login ?? null,
    }))
  })
}

export function fetchSnapshot(run: GhRun, config: Config, now: Date): Snapshot {
  const pagedItems = parseOrCarry(
    run(['api', 'graphql', '--paginate', '--slurp', '-f', `query=${itemsQuery(config)}`, '-F', `projectId=${config.projectId}`]),
  )
  const openIssues = listOpen(run, 'issue', config)
  // PR は、B-OFF-BOARD の対象ではないので、控えの openIssues には入れず、読んで足す候補にだけ使う。
  const openPullRequests = listOpen(run, 'pr', config)
  // ボードに入っている項目が、一覧にも総数にも出ないことがある (足されてから何時間も続く)。ボードに無いと指摘する前に、1 件ずつ読んで足す。
  const items = [...pagedItems, ...readMissingItems(pagedItems, openIssues, config, run, openPullRequests)]
  return { fetchedAt: now.toISOString(), items: withStatusHistory(items, config, run), openIssues }
}

/** GitHub Project のボードを、gh で読む。 */
export function projectBoardSource(run: GhRun, config: Config): BoardSource {
  return { fetchSnapshot: (now) => fetchSnapshot(run, config, now), statusEvents: (items) => statusEventsFor(items, config, run) }
}
