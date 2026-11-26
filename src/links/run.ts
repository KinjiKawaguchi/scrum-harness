import type { Config } from '../config.ts'
import type { BodyThread, CodeHost, IssueBody, IssueThread } from '../ports/index.ts'
import { bodyThreadOf } from './body-thread.ts'
import { appendLine, logError, readJson, releaseLock, tryLock, writeJson, type Paths } from '../store.ts'
import { linksOf, type LinksConfig } from './config.ts'
import { isSkipped, referencedNumbers, type OpenPr } from './extract.ts'
import { updateBody, type PrEntry } from './section.ts'

/** How to rewrite one issue's body. before is the body read when the plan was made (just before writing, it is re-read and checked to be the same as this). */
export type LinkPlan = {
  readonly repo: string
  readonly issue: number
  readonly entries: readonly PrEntry[]
  readonly before: string
  readonly after: string
}

/** The plan, and the numbers of issues that are not rewritten (the markers are broken, or the markers cannot be read even in the body after writing. Both in ascending issue number). */
export type Planning = { readonly plans: readonly LinkPlan[]; readonly broken: readonly number[] }

/**
 * For each open issue, builds the new body between the markers, lining up the open PRs that point at its number. Only issues whose body changes go into the plan.
 * The conditions for PRs not being counted (Dependabot, release/, sync/) and how the numbers pointed at are read are in extract.ts. The place to add to is decided by the list of open issues, so
 * a PR number, or a number that does not exist, being pointed at is not added anywhere. Only between the markers is rewritten, and what a person wrote is not touched (section.ts).
 * For an issue whose PR closed and which has no PR pointing at it, the pair of markers is removed. A body with broken markers is not rewritten and is put in broken.
 * The body after writing is also run through again to check it does not change (the markers are readable). In a body with an unclosed code fence, the added markers land inside the fence and cannot be read, and
 * a pair of markers is added on every run. Such a body is also put in broken.
 * The list of issues comes back newest first, so it is reordered in ascending number (the upper limit on the number rewritten per run is applied in ascending order).
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

/** Reads PRs, and reads and writes issue bodies. */
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
 * Rewrites one issue. Just before writing, re-reads the body, and if it differs from the body when the plan was made (a person edited it), does not write.
 * The body before writing is kept in log/links-before.jsonl.
 */
function apply(p: Paths, issues: BodyThread, plan: LinkPlan, now: Date): SkipReason | null {
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

function linkRepo(p: Paths, repo: string, ports: { readonly code: LinkPorts['code']; readonly issues: BodyThread }, links: LinksConfig, now: Date, options: { readonly dryRun: boolean; readonly budget: number }): LinkResult {
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
 * For each of the config's repos, reads the open PRs and rewrites between the markers in issue bodies.
 * The number rewritten in one run is at most maxEditsPerRun across all repositories (in the order of the config's repositories, then ascending issue number). With dryRun, nothing is rewritten and only the plan is returned.
 * A repository that failed to read is recorded and skipped.
 */
export function linkPullRequests(p: Paths, config: Config, now: Date, ports: LinkPorts, options: { readonly dryRun: boolean }): LinkResult {
  const links = linksOf(config)
  // A tracker that cannot rewrite issue bodies has nothing to link into.
  const issues = bodyThreadOf(ports.issues)
  if (issues === null) return EMPTY_RESULT
  const results = config.repos.reduce<readonly LinkResult[]>((done, repo) => {
    const budget = links.maxEditsPerRun - done.reduce((total, result) => total + result.applied.length + result.skipped.length, 0)
    try {
      return [...done, linkRepo(p, repo, { code: ports.code, issues }, links, now, { ...options, budget })]
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

/** Whether intervalMinutes have passed since the last run. */
export function isLinksDue(p: Paths, config: Config, now: Date): boolean {
  const links = linksOf(config)
  if (!links.enabled) return false
  const last = readJson<string | null>(p.linksState, null)
  return last === null || now.getTime() - Date.parse(last) >= links.intervalMinutes * 60_000
}

/** Called from the TechLead's watch process. If the interval has come, runs once. The time is written at the point of deciding to run (even on failure, it does not try every 30 seconds). */
export function runLinksIfDue(p: Paths, config: Config, now: Date, ports: LinkPorts): LinkResult | null {
  if (!isLinksDue(p, config, now) || !tryLock(p.linksLock)) return null
  try {
    writeJson(p.linksState, now.toISOString())
    return linkPullRequests(p, config, now, ports, { dryRun: false })
  } finally {
    releaseLock(p.linksLock)
  }
}
