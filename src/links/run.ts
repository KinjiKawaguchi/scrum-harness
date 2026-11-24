import type { Config } from '../config.ts'
import type { CodeHost, IssueBody, IssueThread } from '../ports/index.ts'
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
export function planLinks(repo: string, prs: readonly OpenPr[], issues: readonly IssueBody[], links: LinksConfig): Planning {
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

/** PR を読み、issue の本文を読み書きする。 */
export type LinkPorts = { readonly code: Pick<CodeHost, 'openPullRequests'>; readonly issues: IssueThread }

export type SkipReason = 'changed' | 'closed' | 'failed'
export type LinkResult = {
  readonly planned: readonly LinkPlan[]
  readonly applied: readonly LinkPlan[]
  readonly skipped: readonly { readonly plan: LinkPlan; readonly reason: SkipReason }[]
  readonly broken: readonly { readonly repo: string; readonly issue: number }[]
}

const EMPTY_RESULT: LinkResult = { planned: [], applied: [], skipped: [], broken: [] }

/**
 * 1 つの issue を書き換える。書く直前に、本文を読み直し、計画を作ったときの本文と違えば (人が直した) 書かない。
 * 書く前の本文は、log/links-before.jsonl に残す。
 */
function apply(p: Paths, issues: IssueThread, plan: LinkPlan, now: Date): SkipReason | null {
  const at = now.toISOString()
  try {
    const current = issues.read(plan.repo, plan.issue)
    const reason: SkipReason | null = !current.isOpen ? 'closed' : current.body !== plan.before ? 'changed' : null
    if (reason !== null) {
      appendLine(p.events, JSON.stringify({ at, type: 'link-skipped', repo: plan.repo, issue: plan.issue, reason }))
      return reason
    }
    appendLine(p.linksBefore, JSON.stringify({ at, repo: plan.repo, issue: plan.issue, body: plan.before }))
    issues.writeBody(plan.repo, plan.issue, plan.after)
    appendLine(p.events, JSON.stringify({ at, type: 'link-prs', repo: plan.repo, issue: plan.issue, prs: plan.entries.map((entry) => entry.number) }))
    return null
  } catch (error) {
    logError(p, `link-prs ${plan.repo}#${plan.issue}`, error)
    return 'failed'
  }
}

function linkRepo(p: Paths, repo: string, ports: LinkPorts, links: LinksConfig, now: Date, options: { readonly dryRun: boolean; readonly budget: number }): LinkResult {
  const { plans, broken } = planLinks(repo, ports.code.openPullRequests(repo), ports.issues.openIssues(repo), links)
  broken.forEach((issue) => appendLine(p.events, JSON.stringify({ at: now.toISOString(), type: 'link-broken', repo, issue })))
  const targets = options.dryRun ? [] : plans.slice(0, options.budget)
  const outcomes = targets.map((plan) => ({ plan, reason: apply(p, ports.issues, plan, now) }))
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
export function linkPullRequests(p: Paths, config: Config, now: Date, ports: LinkPorts, options: { readonly dryRun: boolean }): LinkResult {
  const links = linksOf(config)
  const results = config.repos.reduce<readonly LinkResult[]>((done, repo) => {
    const budget = links.maxEditsPerRun - done.reduce((total, result) => total + result.applied.length + result.skipped.length, 0)
    try {
      return [...done, linkRepo(p, repo, ports, links, now, { ...options, budget })]
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
export function runLinksIfDue(p: Paths, config: Config, now: Date, ports: LinkPorts): LinkResult | null {
  if (!isLinksDue(p, config, now) || !tryLock(p.linksLock)) return null
  try {
    writeJson(p.linksState, now.toISOString())
    return linkPullRequests(p, config, now, ports, { dryRun: false })
  } finally {
    releaseLock(p.linksLock)
  }
}
