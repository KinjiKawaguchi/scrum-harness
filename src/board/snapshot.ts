import { gh } from '../github.ts'
import type { Config } from '../config.ts'
import { recordCompletions } from '../sprint/completion.ts'
import { withStatusHistory } from '../sprint/history.ts'
import { FetchError, saveFailedFetch } from './fetch-log.ts'
import { itemNodeSelection, normalizeNodes, type RawNode } from './item-node.ts'
import { readMissingItems } from './off-board.ts'
import { logError, readJson, releaseLock, tryLock, writeJson, type Paths } from '../store.ts'
import type { BoardItem, OpenIssue, Snapshot } from './types.ts'

export { normalizeNodes }

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
    throw new Error(`ボードの項目 ${total} 件のうち ${items.length} 件しか取れていない。ページの取得が途中で切れた疑いがあるので、控えは書き換えない`)
  }
  if (items.length === 0) throw new Error('ボードの項目が 0 件。取得に失敗した疑いがあるので、控えは書き換えない')
  const contentItems = items.filter((item) => item.kind !== 'draft')
  const unreadable = contentItems.filter((item) => item.number === null).length
  if (contentItems.length >= UNREADABLE_MIN_ITEMS && unreadable / contentItems.length > UNREADABLE_LIMIT) {
    throw new Error(`issue と PR の項目 ${contentItems.length} 件のうち ${unreadable} 件の中身が読めない。トークンの権限を疑う。控えは書き換えない`)
  }
}

/** `gh api graphql --paginate --slurp` の出力から、ボードの項目を取り出す。形が違うか、項目が読めなければ投げる。 */
export function parseItemPages(output: string): readonly BoardItem[] {
  const pages: unknown = JSON.parse(output)
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error(`ボードの取得結果がページの配列でない: ${output.slice(0, 200)}`)
  }
  const total = (pages[0] as RawPage | undefined)?.data?.node?.items?.totalCount
  if (typeof total !== 'number') throw new Error(`ボードの取得結果に項目の総数 (totalCount) が無い: ${JSON.stringify(pages[0]).slice(0, 200)}`)
  const nodes = (pages as readonly RawPage[]).flatMap((page, index): readonly RawNode[] => {
    const found = page?.data?.node?.items?.nodes
    if (!Array.isArray(found)) {
      throw new Error(`ボードの取得結果の ${index + 1} ページ目に項目の一覧が無い: ${JSON.stringify(page).slice(0, 200)}`)
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
function listOpen(kind: 'issue' | 'pr', config: Config): readonly OpenIssue[] {
  return config.repos.flatMap((repo): readonly OpenIssue[] => {
    const raw = JSON.parse(gh([kind, 'list', '-R', repo, '--state', 'open', '--limit', '1000', '--json', 'number,author']))
    return (raw as readonly { number: number; author?: { login?: string } }[]).map((one) => ({
      repo,
      number: one.number,
      author: one.author?.login ?? null,
    }))
  })
}

export function fetchSnapshot(config: Config, now: Date): Snapshot {
  const pagedItems = parseOrCarry(
    gh(['api', 'graphql', '--paginate', '--slurp', '-f', `query=${itemsQuery(config)}`, '-F', `projectId=${config.projectId}`]),
  )
  const openIssues = listOpen('issue', config)
  // PR は、B-OFF-BOARD の対象ではないので、控えの openIssues には入れず、読んで足す候補にだけ使う。
  const openPullRequests = listOpen('pr', config)
  // ボードに入っている項目が、一覧にも総数にも出ないことがある (足されてから何時間も続く)。ボードに無いと指摘する前に、1 件ずつ読んで足す。
  const items = [...pagedItems, ...readMissingItems(pagedItems, openIssues, config, gh, openPullRequests)]
  return { fetchedAt: now.toISOString(), items: withStatusHistory(items, config), openIssues }
}

export function loadSnapshot(p: Paths): Snapshot | null {
  return readJson<Snapshot | null>(p.snapshot, null)
}

export function saveSnapshot(p: Paths, snapshot: Snapshot): void {
  writeJson(p.snapshot, snapshot)
}

/** 最後に取り直して取れた控え。済んだ issue を見つける比べの元で、フックが Status を直して書く控え (loadSnapshot) とは別にする。 */
export function loadFetchedSnapshot(p: Paths): Snapshot | null {
  return readJson<Snapshot | null>(p.fetchedSnapshot, null)
}

export function isStale(snapshot: Snapshot | null, config: Config, now: Date): boolean {
  return snapshot === null || now.getTime() - Date.parse(snapshot.fetchedAt) > config.refreshSeconds * 1000
}

/** 控えが古く、かつ前に試してから refreshSeconds 経っているか。失敗が続いても GraphQL の上限を使い切らないため。 */
export function isRefreshDue(p: Paths, config: Config, now: Date): boolean {
  if (!isStale(loadSnapshot(p), config, now)) return false
  const attemptedAt = readJson<string | null>(p.refreshAttempt, null)
  return attemptedAt === null || now.getTime() - Date.parse(attemptedAt) > config.refreshSeconds * 1000
}

/**
 * 作業中から済みになった issue の記録。控えは書いた後なので、失敗しても取り直しは成功のままにして、errors.log に残す。
 * 記録に成功したかを返す。失敗したら、比べの元 (最後に取った控え) を進めず、次の取り直しで、同じ issue をもう一度見つける。
 */
function noteCompletions(p: Paths, previous: Snapshot | null, fresh: Snapshot, config: Config, now: Date): boolean {
  try {
    recordCompletions(p, previous, fresh, config, now)
    return true
  } catch (error) {
    logError(p, 'completions', error)
    return false
  }
}

/** ボードを取り直して控えに書く。ほかのプロセスが取り直し中なら何もしない。 */
export function refreshSnapshot(p: Paths, config: Config, now: Date): Snapshot | null {
  if (!tryLock(p.refreshLock)) return null
  try {
    writeJson(p.refreshAttempt, now.toISOString())
    // 比べの元は、最後に取り直して取れた控え。Status を書き換えるスクリプト (scripts.setStatus) の後にフックが Status を直した控え (loadSnapshot) は、
    // すでに完了になっていて、作業中から完了への変化が見えないので使わない。まだ無ければ (この仕組みの最初)、いまの控えにする
    const previous = loadFetchedSnapshot(p) ?? loadSnapshot(p)
    const snapshot = fetchSnapshot(config, now)
    saveSnapshot(p, snapshot)
    if (noteCompletions(p, previous, snapshot, config, now)) writeJson(p.fetchedSnapshot, snapshot)
    return snapshot
  } catch (error) {
    logError(p, 'refresh', error)
    if (error instanceof FetchError) saveFailedFetch(p, now, error.raw)
    return null
  } finally {
    releaseLock(p.refreshLock)
  }
}
