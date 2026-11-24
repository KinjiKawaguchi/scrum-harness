import { shortRepo, type Config } from '../../config.ts'
import type { GhRun } from './gh.ts'
import { itemNodeSelection, normalizeNodes, type RawNode } from './item-node.ts'
import type { BoardItem, OpenIssue } from '../../board/types.ts'

/**
 * An item that is on the board may appear neither in the page list (items) nor in the total (totalCount). This can last for hours after it is added,
 * and it happens even when the total matches the number of listed items, so it cannot be found from a count difference. If the board copy were written as is, an issue that is on the board
 * would be flagged as "not on the board" (B-OFF-BOARD).
 * Before flagging, open issues that look like they are not on the board are read one by one (projectItems), and those on the board are added as items.
 * The whole page is not fetched again, so the GraphQL calls are 0 when nothing is missing and 1 per several issues when something is.
 * Open PRs are added with the same read. The target for which B-OFF-BOARD is raised stays issues; an open PR that is not on the board is neither added nor flagged.
 * Closed PRs (including merged ones) are not added.
 */

/** The number of issues combined into one query. Each gets its own alias, and they are lined up in one GraphQL. */
export const READ_BATCH_SIZE = 25
/** The upper limit on the number of projects read for one issue. */
const PROJECT_ITEMS_LIMIT = 20

const REPO_NAME = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/

const keyOf = (item: { readonly repo: string; readonly number: number | null }): string => `${shortRepo(item.repo)}#${item.number ?? '?'}`

/** Open issues that are not in the result of reading the board. Same as the target of B-OFF-BOARD in rules.ts; issues by excluded authors are not included. */
export function offBoardCandidates(items: readonly BoardItem[], openIssues: readonly OpenIssue[], config: Config): readonly OpenIssue[] {
  const onBoard = new Set(items.map(keyOf))
  return openIssues.filter((open) => !config.excludeAuthors.includes(open.author ?? '')).filter((open) => !onBoard.has(keyOf(open)))
}

/** The target to read one by one. A PR has a different query name (pullRequest) from an issue, so it is marked. */
export type ReadCandidate = OpenIssue & { readonly isPullRequest?: boolean }

function aliasQuery(candidate: ReadCandidate, index: number, selection: string): string {
  const parts = REPO_NAME.exec(candidate.repo)
  if (parts === null || !Number.isInteger(candidate.number)) {
    throw new Error(`cannot read how the open issue is referenced: ${candidate.repo}#${candidate.number}`)
  }
  const kind = candidate.isPullRequest === true ? 'pullRequest' : 'issue'
  return `c${index}: repository(owner:"${parts[1]}", name:"${parts[2]}"){ ${kind}(number:${candidate.number}){ projectItems(first:${PROJECT_ITEMS_LIMIT}){ nodes{ project{ id } ${selection} } } } }`
}

/** A query that reads each issue and PR of candidates, one by one, as an item of the projects it is in. The aliases are c0, c1, .... */
export function readQuery(candidates: readonly ReadCandidate[], config: Config): string {
  const selection = itemNodeSelection(config)
  return `query{ ${candidates.map((candidate, index) => aliasQuery(candidate, index, selection)).join(' ')} }`
}

type ReadNode = RawNode & { readonly project?: { readonly id?: string } | null }
type ReadContent = { readonly projectItems?: { readonly nodes?: readonly ReadNode[] } | null } | null
type ReadResult = {
  readonly data?: Readonly<Record<string, { readonly issue?: ReadContent; readonly pullRequest?: ReadContent } | null>> | null
}

/** From the result read, extracts only the items that are on the config's board (projectId). An issue that cannot be read (null) is skipped as not being on it. */
function parseRead(output: string, count: number, config: Config): readonly RawNode[] {
  const result: ReadResult = JSON.parse(output)
  const data = result.data
  if (data === undefined || data === null) throw new Error(`the result of reading the issue items has no data: ${output.slice(0, 200)}`)
  return Array.from({ length: count }, (_, index) => data[`c${index}`]?.issue?.projectItems?.nodes ?? data[`c${index}`]?.pullRequest?.projectItems?.nodes ?? [])
    .flatMap((nodes) => nodes.filter((node) => node.project?.id === config.projectId).slice(0, 1))
}

/**
 * If an issue disappeared while reading (deleted or moved, so the issue the number points to is gone), GraphQL returns NOT_FOUND and gh
 * exits with code 1. If the standard output then contains only NOT_FOUND errors and has the results of the other issues, those results are used
 * (one vanished issue does not stop the rewrite of the whole board copy). Other failures such as permissions or limits are thrown as they are.
 */
function readOne(run: GhRun, query: string): string {
  try {
    return run(['api', 'graphql', '-f', `query=${query}`])
  } catch (error) {
    const stdout = (error as { readonly stdout?: unknown }).stdout
    if (typeof stdout === 'string' && isOnlyNotFound(stdout)) return stdout
    throw error
  }
}

function isOnlyNotFound(output: string): boolean {
  try {
    const result: { readonly data?: unknown; readonly errors?: readonly { readonly type?: string }[] } = JSON.parse(output)
    const errors = result.errors ?? []
    return typeof result.data === 'object' && result.data !== null && errors.length > 0 && errors.every((one) => one.type === 'NOT_FOUND')
  } catch {
    return false
  }
}

function chunksOf<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size))
}

/**
 * Among the open issues and open PRs not in the result of reading the board (items), returns as items those that are actually on the board.
 * Those that are not on the board are not returned (an issue is a real B-OFF-BOARD; a PR is not a target of a finding). Throws if reading fails.
 * The caller does not rewrite the board copy.
 */
export function readMissingItems(
  items: readonly BoardItem[],
  openIssues: readonly OpenIssue[],
  config: Config,
  run: GhRun,
  openPullRequests: readonly OpenIssue[] = [],
): readonly BoardItem[] {
  const candidates: readonly ReadCandidate[] = [
    ...offBoardCandidates(items, openIssues, config),
    ...offBoardCandidates(items, openPullRequests, config).map((candidate) => ({ ...candidate, isPullRequest: true })),
  ]
  const known = new Set(items.map((item) => item.itemId))
  return chunksOf(candidates, READ_BATCH_SIZE)
    .flatMap((chunk) => parseRead(readOne(run, readQuery(chunk, config)), chunk.length, config))
    .filter((node) => !known.has(node.id))
    .flatMap((node) => normalizeNodes([node]))
}
