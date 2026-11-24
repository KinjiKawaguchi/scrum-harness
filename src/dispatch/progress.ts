import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import type { Config } from '../config.ts'
import { gh, type GhRun } from '../github.ts'
import { readJson, writeJson, type Paths } from '../store.ts'

/**
 * issue の作業が進んだかを見るための印。促しを送った時点の印と、いまの印を比べて、違えば作業が進んだ。
 * board は、ボードの Status、止まっている理由、担当、止まり始めた日。github は、issue のコメントの数、紐づいたブランチの先頭、
 * その issue の PR の番号と状態と先頭のコミット (読めなければ null)。
 * PR は、ほかの人の PR を拾わないよう絞る: 紐づいたブランチ (仕事を渡したときに作る、issue ごとに 1 本) があれば、そのブランチから出た PR だけ。
 * 紐づいたブランチが無ければ、題の括弧の中か、ブランチ名の先頭の番号が、その issue と合う PR だけ。
 */
export type ProgressToken = { readonly board: string; readonly github: string | null }

/** 印を取る。issue ごとの gh の呼び出しの結果は、同じ issue を続けて見ても、短い間は使い回す。 */
export type TokenOf = (item: BoardItem) => ProgressToken

/** gh から取る印の部分 (読めなければ null か、投げる)。 */
export type ProgressProbe = (item: BoardItem) => string | null

export function boardToken(item: BoardItem): string {
  return [item.status ?? '', item.reason ?? '', item.tanto ?? '', item.since ?? ''].join('|')
}

/** 印が変わっていれば、作業が進んだ。どちらかが無い (記録の前の形) ときと、gh の印がどちらかで読めていないときは、進んだとは言わない。 */
export function hasProgress(before: ProgressToken | undefined, after: ProgressToken | undefined): boolean {
  if (before === undefined || after === undefined) return false
  if (before.board !== after.board) return true
  return before.github !== null && after.github !== null && before.github !== after.github
}

/**
 * 部下ごと、issue ごとに、最後に見た印と、印が変わった (作業が進んだ) 時刻。
 * 進んで idleMinutes たつまでは促さず、A-NUDGE-IGNORED も、促しの判断と同じ印 (gh の印を含む) で比べるために持つ。
 */
export type SeenProgress = { readonly token: ProgressToken; readonly at: string }
export type SeenMap = Readonly<Record<string, SeenProgress>>

export function seenKey(member: string, issue: string): string {
  return `${member}|${issue}`
}

/**
 * 印を見たことを覚える。前と比べて進んでいれば (初めて見たときも) 時刻を今にし、変わっていなければ前の時刻のまま。
 * 同じ部下の、別の issue の分は捨てる (自分の作業中が変われば、前の issue の印は要らない)。
 */
export function observe(seen: SeenMap, member: string, issue: string, token: ProgressToken, now: Date): SeenMap {
  const before = seen[seenKey(member, issue)]
  const at = before === undefined || hasProgress(before.token, token) ? now.toISOString() : before.at
  const others = Object.entries(seen).filter(([key]) => !key.startsWith(`${member}|`))
  return Object.fromEntries([...others, [seenKey(member, issue), { token, at }]])
}

const isToken = (value: unknown): value is ProgressToken => {
  const token = value as { board?: unknown; github?: unknown } | null
  return typeof token === 'object' && token !== null && typeof token.board === 'string' && (token.github === null || typeof token.github === 'string')
}

const isSeenProgress = (value: unknown): value is SeenProgress => {
  const seen = value as { token?: unknown; at?: unknown } | null
  return typeof seen === 'object' && seen !== null && isToken(seen.token) && typeof seen.at === 'string' && !Number.isNaN(Date.parse(seen.at))
}

/** 保存した印を読む。無いか、形が違う項目は捨てる。 */
export function readSeen(p: Paths): SeenMap {
  const raw = readJson<unknown>(p.dispatchSeen, {})
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => isSeenProgress(value)))
}

export function writeSeen(p: Paths, seen: SeenMap): void {
  writeJson(p.dispatchSeen, seen)
}

/** gh の印を使わず、ボードの印だけで比べる。 */
export const boardOnly: TokenOf = (item) => ({ board: boardToken(item), github: null })

const QUERY = `query($owner:String!, $name:String!, $number:Int!){ repository(owner:$owner, name:$name){ issue(number:$number){
  comments{ totalCount }
  linkedBranches(first:5){ nodes{ ref{ name target{ oid } } } }
  timelineItems(last:50, itemTypes:[CROSS_REFERENCED_EVENT]){ nodes{ ... on CrossReferencedEvent{ source{ ... on PullRequest{ number state headRefOid headRefName title } } } } } } } }`

type IssueActivity = {
  readonly comments?: { readonly totalCount?: unknown }
  readonly linkedBranches?: { readonly nodes?: readonly { readonly ref?: { readonly name?: unknown; readonly target?: { readonly oid?: unknown } } | null }[] }
  readonly timelineItems?: {
    readonly nodes?: readonly {
      readonly source?: { readonly number?: unknown; readonly state?: unknown; readonly headRefOid?: unknown; readonly headRefName?: unknown; readonly title?: unknown } | null
    }[]
  }
}

/** 題の括弧の中の `#N` (`feat: x (#123)`、`(#123、#124)`)。 */
function titleCites(title: string, number: number): boolean {
  return [...title.matchAll(/\(([^)]*)\)/g)].some((group) => [...(group[1] ?? '').matchAll(/#(\d+)\b/g)].some((one) => Number(one[1]) === number))
}

/** ブランチ名の先頭の番号 (`feat/456-ci`、`456-foo`)。番号の後ろが `-`、`_`、`/` か終わりのときだけ。 */
function branchStartsWith(name: string, number: number): boolean {
  const match = /^(?:[a-z]+\/)?(\d+)(?:[-_/]|$)/.exec(name)
  return match !== null && Number(match[1]) === number
}

/** gh の答えを、順に並べた安定した文字列にする。issue が無ければ投げる。number は、その issue の番号 (PR を絞るのに使う)。 */
export function activityToken(output: string, number: number | null = null): string {
  const issue = (JSON.parse(output) as { data?: { repository?: { issue?: IssueActivity | null } | null } }).data?.repository?.issue
  if (!issue) throw new Error('issue を読めない')
  const branches = (issue.linkedBranches?.nodes ?? []).flatMap((node) => (node.ref ? [`${String(node.ref.name)}@${String(node.ref.target?.oid)}`] : []))
  const linkedNames = (issue.linkedBranches?.nodes ?? []).flatMap((node) => (node.ref && typeof node.ref.name === 'string' ? [node.ref.name] : []))
  const isOwn = (source: { readonly headRefName?: unknown; readonly title?: unknown }): boolean => {
    const branch = typeof source.headRefName === 'string' ? source.headRefName : ''
    if (linkedNames.length > 0) return linkedNames.includes(branch)
    return number !== null && (branchStartsWith(branch, number) || titleCites(typeof source.title === 'string' ? source.title : '', number))
  }
  const prs = (issue.timelineItems?.nodes ?? []).flatMap((node) => {
    const source = node.source
    return source && typeof source.number === 'number' && isOwn(source) ? [`#${source.number}:${String(source.state)}@${String(source.headRefOid)}`] : []
  })
  return JSON.stringify({ comments: issue.comments?.totalCount ?? 0, branches: branches.toSorted(), prs: prs.toSorted() })
}

export function githubProbe(run: GhRun): ProgressProbe {
  return (item) => {
    if (item.number === null) return null
    const [owner = '', name = ''] = item.repo.split('/')
    return activityToken(run(['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${item.number}`]), item.number)
  }
}

const CACHE_TTL_MS = 5 * 60_000

/** 同じ issue の gh の呼び出しを、ttlMs の間は使い回す (30 秒ごとの待機が、gh を叩き続けないため)。失敗も使い回す。 */
export function cachedProbe(probe: ProgressProbe, ttlMs: number = CACHE_TTL_MS, clock: () => number = Date.now): ProgressProbe {
  const cache = new Map<string, { readonly at: number; readonly value: string | null }>()
  return (item) => {
    const key = `${item.repo}#${item.number}`
    const hit = cache.get(key)
    if (hit !== undefined && clock() - hit.at < ttlMs) return hit.value
    const value = (() => {
      try {
        return probe(item)
      } catch {
        return null
      }
    })()
    cache.set(key, { at: clock(), value })
    return value
  }
}

export const defaultProbe: ProgressProbe = cachedProbe(githubProbe(gh))

/** ボードの印と、gh の印を合わせた、いまの印。gh が読めなければ、gh の印は null (ボードの印だけで比べる)。 */
export function tokenWith(probe: ProgressProbe): TokenOf {
  return (item) => ({ board: boardToken(item), github: probe(item) })
}

/** 促しの記録に書く名前。label を使うので、同じ issue かの比べは、リポジトリ名と番号で決まる。 */
export function issueLabel(item: BoardItem): string {
  return label(item)
}
