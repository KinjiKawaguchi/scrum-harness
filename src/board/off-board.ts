import { shortRepo, type Config } from '../config.ts'
import type { GhRun } from '../github.ts'
import { itemNodeSelection, normalizeNodes, type RawNode } from './item-node.ts'
import type { BoardItem, OpenIssue } from './types.ts'

/**
 * ボードに入っている項目が、ページの一覧 (items) にも総数 (totalCount) にも出ないことがある。足されてから何時間も続くことがあり、
 * 総数が一覧の件数と合っていても起きるので、件数の差では見つからない。そのまま控えを書くと、ボードに入っている issue が
 * 「ボードに無い」(B-OFF-BOARD) と指摘される。
 * 指摘する前に、ボードに無いように見える開いた issue を 1 件ずつ読み (projectItems)、ボードに入っていれば項目として足す。
 * ページ全体を取り直さないので、GraphQL の呼び出しは、欠けがないとき 0 回、あるとき数 issue ごとに 1 回で済む。
 * 開いた PR も、同じ読みで足す。B-OFF-BOARD を出す対象は issue のままで、ボードに入っていない開いた PR は、足さず、指摘もしない。
 * 閉じた PR (マージ済みを含む) は足さない。
 */

/** 1 回の問い合わせにまとめる issue の数。1 件ごとに別名を付けて、1 つの GraphQL に並べる。 */
export const READ_BATCH_SIZE = 25
/** 1 つの issue が入っているプロジェクトとして読む数の上限。 */
const PROJECT_ITEMS_LIMIT = 20

const REPO_NAME = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/

const keyOf = (item: { readonly repo: string; readonly number: number | null }): string => `${shortRepo(item.repo)}#${item.number ?? '?'}`

/** ボードを読んだ結果に無い開いた issue。rules.ts の B-OFF-BOARD の対象と同じで、除く作者の issue は入れない。 */
export function offBoardCandidates(items: readonly BoardItem[], openIssues: readonly OpenIssue[], config: Config): readonly OpenIssue[] {
  const onBoard = new Set(items.map(keyOf))
  return openIssues.filter((open) => !config.excludeAuthors.includes(open.author ?? '')).filter((open) => !onBoard.has(keyOf(open)))
}

/** 1 件ずつ読む対象。PR は、issue と問い合わせの名前 (pullRequest) が違うので、印を付ける。 */
export type ReadCandidate = OpenIssue & { readonly isPullRequest?: boolean }

function aliasQuery(candidate: ReadCandidate, index: number, selection: string): string {
  const parts = REPO_NAME.exec(candidate.repo)
  if (parts === null || !Number.isInteger(candidate.number)) {
    throw new Error(`開いた issue の指し方が読めない: ${candidate.repo}#${candidate.number}`)
  }
  const kind = candidate.isPullRequest === true ? 'pullRequest' : 'issue'
  return `c${index}: repository(owner:"${parts[1]}", name:"${parts[2]}"){ ${kind}(number:${candidate.number}){ projectItems(first:${PROJECT_ITEMS_LIMIT}){ nodes{ project{ id } ${selection} } } } }`
}

/** candidates の issue と PR を 1 件ずつ、入っているプロジェクトの項目として読む問い合わせ。別名は c0、c1、…。 */
export function readQuery(candidates: readonly ReadCandidate[], config: Config): string {
  const selection = itemNodeSelection(config)
  return `query{ ${candidates.map((candidate, index) => aliasQuery(candidate, index, selection)).join(' ')} }`
}

type ReadNode = RawNode & { readonly project?: { readonly id?: string } | null }
type ReadContent = { readonly projectItems?: { readonly nodes?: readonly ReadNode[] } | null } | null
type ReadResult = {
  readonly data?: Readonly<Record<string, { readonly issue?: ReadContent; readonly pullRequest?: ReadContent } | null>> | null
}

/** 読んだ結果から、config のボード (projectId) に入っている項目だけを取り出す。issue が読めない (null) ものは、入っていないものとして飛ばす。 */
function parseRead(output: string, count: number, config: Config): readonly RawNode[] {
  const result: ReadResult = JSON.parse(output)
  const data = result.data
  if (data === undefined || data === null) throw new Error(`issue の項目の読み取り結果に data が無い: ${output.slice(0, 200)}`)
  return Array.from({ length: count }, (_, index) => data[`c${index}`]?.issue?.projectItems?.nodes ?? data[`c${index}`]?.pullRequest?.projectItems?.nodes ?? [])
    .flatMap((nodes) => nodes.filter((node) => node.project?.id === config.projectId).slice(0, 1))
}

/**
 * 読んでいる間に消えた (削除や移動で、番号が指す issue が無くなった) issue があると、GraphQL は NOT_FOUND を返し、gh は
 * 終了コード 1 で終わる。そのときの標準出力が、NOT_FOUND だけを含み、ほかの issue の結果を持つなら、その結果を使う
 * (1 件の消えた issue で、控え全体の書き換えを止めない)。権限や上限などのほかの失敗は、そのまま投げる。
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
 * ボードを読んだ結果 (items) に無い開いた issue と開いた PR のうち、実際にはボードに入っているものを、項目として返す。
 * ボードに入っていないものは返さない (issue は B-OFF-BOARD の本物。PR は指摘の対象でない)。読み取りに失敗したら投げる。
 * 呼ぶ側は、控えを書き換えない。
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
