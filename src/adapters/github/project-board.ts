import type { Config } from '../../config.ts'
import type { BoardSource } from '../../ports/index.ts'
import { FetchError } from '../../board/fetch-log.ts'
import { watchedIssues } from '../../board/off-board-scope.ts'
import { scopeToTeam } from '../../board/team-scope.ts'
import type { BoardItem, OpenIssue, Snapshot } from '../../board/types.ts'
import type { GhRun } from './gh.ts'
import { itemNodeSelection, normalizeNodes, type RawNode } from './item-node.ts'
import { readMissingItems } from './off-board.ts'
import { assertTeamValue } from './team-field.ts'
import { statusEventsFor, withStatusHistory } from './status-history.ts'

export function itemsQuery(config: Config): string {
  return `query($projectId:ID!, $endCursor:String){ node(id:$projectId){ ... on ProjectV2 { items(first:100, after:$endCursor){
    totalCount pageInfo{ hasNextPage endCursor } nodes{ ${itemNodeSelection(config)} } } } } }`
}


type RawPage = {
  readonly data?: { readonly node?: { readonly items?: { readonly totalCount?: unknown; readonly nodes?: unknown } | null } | null } | null
}

/** When fewer items are fetched than the total, the count and the ratio allowed for items that vanished from the board during fetching. */
const MISSING_TOLERANCE_COUNT = 3
const MISSING_TOLERANCE_RATIO = 0.01

/** If the share of issue and PR items whose content (number) cannot be read exceeds this ratio, the fetch is considered failed. */
const UNREADABLE_LIMIT = 0.5
/** The count sufficient for judging by ratio. On a board smaller than this, the ratio is not checked. */
const UNREADABLE_MIN_ITEMS = 10

/**
 * A failed fetch can come back as empty items or items with no content, without raising an exception. If written to the board copy as is,
 * every open issue would show up as "not on the board" (B-OFF-BOARD), so it is rejected before writing.
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

/** From the output of `gh api graphql --paginate --slurp`, extracts the board's items. Throws if the shape differs or the items cannot be read. */
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

/** About 2 points per page of 100. A board of 1000 items costs 20 points for all of them and takes ten-odd seconds. */
function parseOrCarry(raw: string): readonly BoardItem[] {
  try {
    return parseItemPages(raw)
  } catch (error) {
    throw new FetchError(error instanceof Error ? error.message : String(error), raw)
  }
}

type RawOpen = { number: number; author?: { login?: string }; labels?: readonly { name?: string }[]; assignees?: readonly { login?: string }[] }

const names = (list: readonly (string | undefined)[]): readonly string[] => list.flatMap((one) => (one === undefined ? [] : [one]))

/** For each configured repository, reads the numbers and authors of open issues or PRs, and the labels and assignees when the off-board scope filters on them. */
function listOpen(run: GhRun, kind: 'issue' | 'pr', config: Config): readonly OpenIssue[] {
  const fields = kind === 'issue' && config.offBoard?.scope === 'filter' ? 'number,author,labels,assignees' : 'number,author'
  return config.repos.flatMap((repo): readonly OpenIssue[] => {
    const raw = JSON.parse(run([kind, 'list', '-R', repo, '--state', 'open', '--limit', '1000', '--json', fields]))
    return (raw as readonly RawOpen[]).map((one) => ({
      repo,
      number: one.number,
      author: one.author?.login ?? null,
      ...(one.labels === undefined ? {} : { labels: names(one.labels.map((label) => label.name)) }),
      ...(one.assignees === undefined ? {} : { assignees: names(one.assignees.map((assignee) => assignee.login)) }),
    }))
  })
}

export function fetchSnapshot(run: GhRun, config: Config, now: Date): Snapshot {
  assertTeamValue(run, config)
  const pagedItems = parseOrCarry(
    run(['api', 'graphql', '--paginate', '--slurp', '-f', `query=${itemsQuery(config)}`, '-F', `projectId=${config.projectId}`]),
  )
  // Only the issues the scope watches are read, so a team in a large shared repository does not list or flag every other team's issue.
  const openIssues = config.offBoard?.scope === 'none' ? [] : watchedIssues(listOpen(run, 'issue', config), config.offBoard)
  // A PR is not a target of B-OFF-BOARD, so it is not put into the board copy's openIssues and is used only as a candidate to read and add.
  const openPullRequests = listOpen(run, 'pr', config)
  // An item on the board may appear neither in the list nor in the total (it can last for hours after it is added). Before flagging it as not on the board, read it one by one and add it.
  const wholeBoard = [...pagedItems, ...readMissingItems(pagedItems, openIssues, config, run, openPullRequests)]
  // The whole board is read and checked first, then narrowed to the team, so a failed read is caught and another team's issues are not reported as off the board.
  const scoped = scopeToTeam(wholeBoard, openIssues, config.team)
  return { fetchedAt: now.toISOString(), items: withStatusHistory(scoped.items, config, run), openIssues: scoped.openIssues }
}

/** Reads the GitHub Project board with gh. */
export function projectBoardSource(run: GhRun, config: Config): BoardSource {
  return { fetchSnapshot: (now) => fetchSnapshot(run, config, now), statusEvents: (items) => statusEventsFor(items, config, run) }
}
