import type { Config } from '../config.ts'
import type { GhRun } from '../dispatch/linked-branch.ts'
import { gh } from '../github.ts'
import { appendLine, logError, readJson, releaseLock, tryLock, writeJson, type Paths } from '../store.ts'
import { linksOf, type LinksConfig } from './config.ts'
import { isSkipped, referencedNumbers, type OpenPr } from './extract.ts'
import { updateBody, type PrEntry } from './section.ts'

/** 1 つの issue の本文を、どう書き換えるか。before は、計画を作ったときに読んだ本文 (書く直前に、これと同じか読み直して照らす)。 */
export type LinkPlan = {
  readonly repo: string
  readonly issue: number
  readonly entries: readonly PrEntry[]
  readonly before: string
  readonly after: string
}

export type OpenIssue = { readonly number: number; readonly body: string }

/** 計画と、書き換えない issue の番号 (印が壊れている、書いた後の本文でも印が読めない。どちらも issue の番号の小さい順)。 */
export type Planning = { readonly plans: readonly LinkPlan[]; readonly broken: readonly number[] }

/**
 * 開いている issue ごとに、その番号を指す開いている PR を並べた、印の間の新しい本文を作る。本文が変わる issue だけを計画に入れる。
 * PR の数えない条件 (Dependabot、release/、sync/) と、指す番号の読み方は extract.ts。足す先は、開いている issue の一覧で決まるので、
 * PR の番号や、無い番号を指しても、どこにも足されない。印の間だけを書き換え、人が書いた所には触らない (section.ts)。
 * PR が閉じて、指す PR が無くなった issue は、印の組が消える。印が壊れている本文は、書き換えず、broken に入れる。
 * 書いた後の本文に流し直して、変わらない (印が読める) ことも見る。閉じていないコードの囲みがある本文は、足した印が囲みの中に入って読めず、
 * 流すたびに印の組が足される。そういう本文も broken に入れる。
 * issue の一覧は新しい順で返ってくるので、番号の小さい順に並べ直す (1 回に書き換える件数の上限は、小さい順に当てる)。
 */
export function planLinks(repo: string, prs: readonly OpenPr[], issues: readonly OpenIssue[], links: LinksConfig): Planning {
  const byIssue = new Map<number, PrEntry[]>()
  prs
    .filter((pr) => !isSkipped(pr, links))
    .forEach((pr) =>
      referencedNumbers(pr).forEach((number) => byIssue.set(number, [...(byIssue.get(number) ?? []), { number: pr.number, title: pr.title }])),
    )
  const updates = issues
    .toSorted((a, b) => a.number - b.number)
    .map((issue) => {
      const entries = (byIssue.get(issue.number) ?? []).toSorted((a, b) => a.number - b.number)
      return { issue, entries, update: updateBody(issue.body, entries) }
    })
  const isStable = (entries: readonly PrEntry[], body: string): boolean => updateBody(body, entries).kind === 'unchanged'
  const isWritable = ({ entries, update }: (typeof updates)[number]): boolean => update.kind === 'updated' && isStable(entries, update.body)
  return {
    plans: updates.flatMap((one) => (isWritable(one) && one.update.kind === 'updated' ? [{ repo, issue: one.issue.number, entries: one.entries, before: one.issue.body, after: one.update.body }] : [])),
    broken: updates.filter((one) => one.update.kind === 'broken' || (one.update.kind === 'updated' && !isWritable(one))).map(({ issue }) => issue.number),
  }
}

function parseList<T>(output: string, pick: (record: Record<string, any>) => T | null): readonly T[] {
  const list: unknown = JSON.parse(output)
  if (!Array.isArray(list)) throw new Error('gh の出力が配列でない')
  return list.flatMap((record) => {
    const one = pick(record as Record<string, any>)
    return one === null ? [] : [one]
  })
}

export function listOpenPrs(run: GhRun, repo: string): readonly OpenPr[] {
  const output = run(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '300', '--json', 'number,title,body,headRefName,author'])
  return parseList(output, (record) =>
    typeof record.number === 'number' && typeof record.title === 'string' && typeof record.headRefName === 'string'
      ? { number: record.number, title: record.title, body: typeof record.body === 'string' ? record.body : '', headRefName: record.headRefName, author: String(record.author?.login ?? '') }
      : null,
  )
}

export function listOpenIssues(run: GhRun, repo: string): readonly OpenIssue[] {
  const output = run(['issue', 'list', '-R', repo, '--state', 'open', '--limit', '1000', '--json', 'number,body'])
  return parseList(output, (record) => (typeof record.number === 'number' ? { number: record.number, body: typeof record.body === 'string' ? record.body : '' } : null))
}

export type SkipReason = 'changed' | 'closed' | 'failed'
export type LinkResult = {
  readonly planned: readonly LinkPlan[]
  readonly applied: readonly LinkPlan[]
  readonly skipped: readonly { readonly plan: LinkPlan; readonly reason: SkipReason }[]
  readonly broken: readonly { readonly repo: string; readonly issue: number }[]
}

const EMPTY_RESULT: LinkResult = { planned: [], applied: [], skipped: [], broken: [] }

/** いまの issue の状態。書く直前に読み直す。 */
function readCurrent(run: GhRun, plan: LinkPlan): { readonly state: string; readonly body: string } {
  const issue = JSON.parse(run(['api', `repos/${plan.repo}/issues/${plan.issue}`])) as { state?: unknown; body?: unknown }
  return { state: String(issue.state ?? ''), body: typeof issue.body === 'string' ? issue.body : '' }
}

/**
 * 1 つの issue を書き換える。書く直前に、本文を読み直し、計画を作ったときの本文と違えば (人が直した) 書かない。
 * 書く前の本文は、log/links-before.jsonl に残す。本文は -f で渡す (-F だと、@ で始まる本文がファイルとして読まれる)。
 */
function apply(p: Paths, run: GhRun, plan: LinkPlan, now: Date): SkipReason | null {
  const at = now.toISOString()
  try {
    const current = readCurrent(run, plan)
    const reason: SkipReason | null = current.state !== 'open' ? 'closed' : current.body !== plan.before ? 'changed' : null
    if (reason !== null) {
      appendLine(p.events, JSON.stringify({ at, type: 'link-skipped', repo: plan.repo, issue: plan.issue, reason }))
      return reason
    }
    appendLine(p.linksBefore, JSON.stringify({ at, repo: plan.repo, issue: plan.issue, body: plan.before }))
    run(['api', '-X', 'PATCH', `repos/${plan.repo}/issues/${plan.issue}`, '-f', `body=${plan.after}`])
    appendLine(p.events, JSON.stringify({ at, type: 'link-prs', repo: plan.repo, issue: plan.issue, prs: plan.entries.map((entry) => entry.number) }))
    return null
  } catch (error) {
    logError(p, `link-prs ${plan.repo}#${plan.issue}`, error)
    return 'failed'
  }
}

function linkRepo(p: Paths, repo: string, run: GhRun, links: LinksConfig, now: Date, options: { readonly dryRun: boolean; readonly budget: number }): LinkResult {
  const { plans, broken } = planLinks(repo, listOpenPrs(run, repo), listOpenIssues(run, repo), links)
  broken.forEach((issue) => appendLine(p.events, JSON.stringify({ at: now.toISOString(), type: 'link-broken', repo, issue })))
  const targets = options.dryRun ? [] : plans.slice(0, options.budget)
  const outcomes = targets.map((plan) => ({ plan, reason: apply(p, run, plan, now) }))
  return {
    planned: plans,
    applied: outcomes.filter(({ reason }) => reason === null).map(({ plan }) => plan),
    skipped: outcomes.flatMap(({ plan, reason }) => (reason === null ? [] : [{ plan, reason }])),
    broken: broken.map((issue) => ({ repo, issue })),
  }
}

/**
 * 設定の repos ごとに、開いている PR を読み、issue の本文の、印の間を書き換える。
 * 1 回に書き換えるのは、リポジトリ全体で maxEditsPerRun 件まで (設定のリポジトリの順に、issue の番号の小さい順)。dryRun なら、何も書き換えず、予定だけを返す。
 * 読むのに失敗したリポジトリは、記録して飛ばす。
 */
export function linkPullRequests(p: Paths, config: Config, now: Date, run: GhRun, options: { readonly dryRun: boolean }): LinkResult {
  const links = linksOf(config)
  const results = config.repos.reduce<readonly LinkResult[]>((done, repo) => {
    const budget = links.maxEditsPerRun - done.reduce((total, result) => total + result.applied.length + result.skipped.length, 0)
    try {
      return [...done, linkRepo(p, repo, run, links, now, { ...options, budget })]
    } catch (error) {
      logError(p, `link-prs ${repo}`, error)
      return [...done, EMPTY_RESULT]
    }
  }, [])
  return {
    planned: results.flatMap((result) => result.planned),
    applied: results.flatMap((result) => result.applied),
    skipped: results.flatMap((result) => result.skipped),
    broken: results.flatMap((result) => result.broken),
  }
}

/** 前に流してから intervalMinutes たっているか。 */
export function isLinksDue(p: Paths, config: Config, now: Date): boolean {
  const links = linksOf(config)
  if (!links.enabled) return false
  const last = readJson<string | null>(p.linksState, null)
  return last === null || now.getTime() - Date.parse(last) >= links.intervalMinutes * 60_000
}

/** TechLead の待機プロセスから呼ぶ。間隔が来ていれば、1 回流す。流すと決めた時点で時刻を書く (失敗しても、30 秒ごとには試さない)。 */
export function runLinksIfDue(p: Paths, config: Config, now: Date, run: GhRun = gh): LinkResult | null {
  if (!isLinksDue(p, config, now) || !tryLock(p.linksLock)) return null
  try {
    writeJson(p.linksState, now.toISOString())
    return linkPullRequests(p, config, now, run, { dryRun: false })
  } finally {
    releaseLock(p.linksLock)
  }
}
