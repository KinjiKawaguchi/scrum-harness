import { makeFinding, type Finding } from '../findings/types.ts'
import type { GraphqlAllowance } from '../ports/index.ts'
import type { CostRecord } from './shared.ts'
import type { UseSummary } from './graphql-use.ts'

/** The lead is warned when what is left of the hour's GraphQL points is below this fraction of the limit. */
export const LOW_FRACTION = 0.2

/** A reading older than this says nothing about the hour that is going now. */
const STALE_MS = 60 * 60_000

const clock = (iso: string): string => iso.slice(11, 16)

/**
 * B-GRAPHQL-LOW: the board read says that less than a fifth of the hour's GraphQL points is left. Every harness, member, daemon, and tool that uses the owner's
 * login spends from the same allowance, and past it GitHub refuses reads and, before that, the creation of comments, issues, and pull requests. Medium, so
 * the lead hears of it once for the hour (the key has the time the allowance resets). It is not shown once that time has passed.
 */
export function lintGraphqlAllowance(record: CostRecord | null, now: Date): readonly Finding[] {
  const cost = record?.cost
  if (record === null || cost === undefined) return []
  if (now.getTime() >= Date.parse(cost.resetAt) || now.getTime() - Date.parse(record.boardAt) > STALE_MS) return []
  if (cost.remaining >= cost.limit * LOW_FRACTION) return []
  return [
    makeFinding({
      rule: 'B-GRAPHQL-LOW',
      subject: 'github',
      severity: 'medium',
      message: `Only ${cost.remaining} of ${cost.limit} GraphQL points are left this hour (they reset at ${clock(cost.resetAt)} UTC, as of the board read at ${clock(record.boardAt)} UTC). Every harness, member, and daemon that uses this login spends from them`,
      fix: 'Hold back what reads GitHub in bulk (board refreshes, scans, full test runs that call it) until the reset; teams on one machine share one board read (SCRUM_SHARED_DIR), so check that sharing is on',
      keySuffix: cost.resetAt,
    }),
  ]
}

/** The words `scrum refresh` adds about how it got the board and what that cost. Empty when there is nothing to say. */
export function describeCost(record: CostRecord | null, now: Date): string {
  if (record === null) return ''
  const left = record.cost === undefined ? '' : `${record.cost.remaining} of ${record.cost.limit} GraphQL points left, they reset at ${clock(record.cost.resetAt)} UTC`
  if (record.via === 'held') {
    const age = Math.max(0, Math.round((now.getTime() - Date.parse(record.boardAt)) / 1000))
    return `board read held back to leave the GraphQL points to others (${left}); using the copy read ${age} seconds ago`
  }
  if (record.via === 'fetched') return `board read: ${record.cost === undefined ? 'the cost is not known' : `${record.cost.cost} GraphQL points (${left})`}`
  if (record.via === 'shared') {
    const age = Math.max(0, Math.round((now.getTime() - Date.parse(record.boardAt)) / 1000))
    return `board copy shared with the other teams (read ${age} seconds ago${record.cost === undefined ? '' : `, ${record.cost.cost} points then, ${left}`})`
  }
  return record.cost === undefined ? '' : `board read: ${record.cost.cost} GraphQL points (${left})`
}

/** Below this fraction of the hour's points left, the board is read less often; below the next, not at all until the points reset. */
export const SLOW_FRACTION = 0.2
export const STOP_FRACTION = 0.05

/** How much longer than `refreshSeconds` the board waits between reads while the points are running low, and the shortest wait then. */
const SLOW_FACTOR = 4
const SLOW_LEAST_SECONDS = 10 * 60

/**
 * Whether a read of the board that would be made is held back, so that people and agents keep a part of the hour's points: with a fifth left the board is
 * read at a quarter of the usual pace (and not more often than every ten minutes), with a twentieth left not until the points reset. `copyAt` is when
 * the board copy there is was read (null when there is none, which a stretched wait cannot be measured against, so it is read).
 */
export function isReadHeld(allowance: GraphqlAllowance | null, copyAt: string | null, refreshSeconds: number, now: Date): boolean {
  if (allowance === null || allowance.limit <= 0 || now.getTime() >= Date.parse(allowance.resetAt)) return false
  const share = allowance.remaining / allowance.limit
  if (share < STOP_FRACTION) return true
  if (share >= SLOW_FRACTION || copyAt === null) return false
  return now.getTime() - Date.parse(copyAt) < Math.max(refreshSeconds * SLOW_FACTOR, SLOW_LEAST_SECONDS) * 1000
}

/** The harness's own use of the hour's points is at least this fraction of the limit: medium; at the second, high. */
export const USE_NOTICE_FRACTION = 0.25
export const USE_HIGH_FRACTION = 0.5

const TOP_KINDS = 3

/**
 * B-GRAPHQL-USE: what the harness itself spent of the hour's GraphQL points, counted from its own calls (a call that does not say its cost counts as 1, so
 * it is at least that), once it is a quarter of the limit; half of it is high. The wait for the limit to lift is the other half of the answer, so the
 * finding says which calls cost the most.
 */
export function lintGraphqlUse(summary: UseSummary, limit: number | null): readonly Finding[] {
  if (limit === null || limit <= 0 || summary.points < limit * USE_NOTICE_FRACTION) return []
  const top = summary.byWhat.slice(0, TOP_KINDS).map((one) => `${one.what} ${one.points} (${one.calls} calls)`).join(', ')
  return [
    makeFinding({
      rule: 'B-GRAPHQL-USE',
      subject: 'github',
      severity: summary.points >= limit * USE_HIGH_FRACTION ? 'high' : 'medium',
      message: `The harness spent at least ${summary.points} of ${limit} GraphQL points in the last hour (${summary.calls} calls; most on ${top})`,
      fix: 'Teams on one machine share one board read (SCRUM_SHARED_DIR); raise refreshSeconds, or find what calls so often',
      keySuffix: summary.points >= limit * USE_HIGH_FRACTION ? 'high' : 'medium',
    }),
  ]
}

/** The words `scrum refresh` adds about the harness's own use in the last hour. Empty when it used none. */
export function describeUse(summary: UseSummary): string {
  return summary.calls === 0 ? '' : `the harness used at least ${summary.points} GraphQL points in the last hour (${summary.calls} calls)`
}
