import { makeFinding, type Finding } from '../findings/types.ts'
import type { CostRecord } from './shared.ts'

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
  if (record.via === 'fetched') return `board read: ${record.cost === undefined ? 'the cost is not known' : `${record.cost.cost} GraphQL points (${left})`}`
  if (record.via === 'shared') {
    const age = Math.max(0, Math.round((now.getTime() - Date.parse(record.boardAt)) / 1000))
    return `board copy shared with the other teams (read ${age} seconds ago${record.cost === undefined ? '' : `, ${record.cost.cost} points then, ${left}`})`
  }
  return record.cost === undefined ? '' : `board read: ${record.cost.cost} GraphQL points (${left})`
}
