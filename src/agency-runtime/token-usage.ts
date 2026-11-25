import { membersBySession, sessionNames } from '../usage/attribution.ts'
import { readIndex } from '../usage/index-store.ts'
import { isIndexStale, teamNamesOf } from '../usage/run.ts'
import { summarize } from '../usage/summary.ts'
import { usageOffsetMinutes } from './config.ts'
import type { RuntimeDeps } from './handle.ts'
import type { RuntimeError, TokenUsage, TokenUsageRequest } from './types.ts'

const fail = (status: number, message: string): { readonly error: RuntimeError } => ({ error: { status, message } })

/**
 * Token use of the team by day and person, from the index of the agents' transcripts. The index is read again in the background when
 * it is stale, so a call never waits for the transcripts; it answers from what the index holds. 404 means the team has no usage.
 */
export function tokenUsage(request: TokenUsageRequest, deps: RuntimeDeps): { readonly result: TokenUsage } | { readonly error: RuntimeError } {
  const { p, config, now, ports } = deps
  const index = readIndex(p.usageIndex)
  if (index === null || isIndexStale(p, now)) deps.spawnUsageIndex()
  if (index === null) return fail(503, 'the token usage has not been read yet; reading it was started')
  const memberOf = membersBySession(index, sessionNames(p, ports.transcripts), teamNamesOf(config))
  if (memberOf.size === 0) return fail(404, 'no session of this team has recorded usage')
  const { byDay, byPerson } = summarize({ index, memberOf, days: request.days, now, offsetMinutes: usageOffsetMinutes(config) })
  return { result: { org: request.org, team: request.team, days: request.days, generatedAt: now.toISOString(), byDay, byPerson } }
}
