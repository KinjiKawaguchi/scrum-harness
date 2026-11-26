import { label } from '../board/rules.ts'
import { loadSnapshot } from '../board/snapshot.ts'
import { readPrAuthorRecords, type PrAuthor } from '../team/pr-authors.ts'
import { readStateMarks } from '../team/state-log.ts'
import { stateSecondsByMember, type SessionLife } from '../team/state-time.ts'
import { readHeartbeats } from '../team/heartbeat.ts'
import { baseName, membersBySession, sessionNames } from '../usage/attribution.ts'
import { dailyUsage } from '../usage/daily.ts'
import { readIndex } from '../usage/index-store.ts'
import { isIndexStale, teamNamesOf } from '../usage/run.ts'
import { lastDates } from '../usage/summary.ts'
import { usageOffsetMinutes } from './config.ts'
import type { RuntimeDeps } from './handle.ts'
import type { ParticipantDay, ParticipantMetrics, ParticipantMetricsRequest, PullRequestAuthor, RuntimeError } from './types.ts'

const fail = (status: number, message: string): { readonly error: RuntimeError } => ({ error: { status, message } })

/** The most pull requests a report lists (the node refuses more). The newest are kept. */
const MAX_PULL_REQUESTS = 10_000

const isEmptyDay = (day: ParticipantDay): boolean =>
  day.busySeconds === 0 && day.waitingSeconds === 0 && day.idleSeconds === 0 && day.costUsd === 0 && day.tokens.input + day.tokens.output + day.tokens.cacheRead + day.tokens.cacheWrite === 0

/** The pull requests whose opener the hooks saw, once each, named as GitHub names them. A record with no repository is looked up on the board; one it is not on is left out. */
function pullRequestsOf(records: readonly PrAuthor[], board: ReturnType<typeof loadSnapshot>): readonly PullRequestAuthor[] {
  const onBoard = new Map((board?.items ?? []).filter((item) => item.kind === 'pr' && item.number !== null).map((item) => [label(item), item] as const))
  const seen = new Set<string>()
  const found = records.flatMap((record): readonly PullRequestAuthor[] => {
    const item = onBoard.get(record.ref)
    const repo = record.repo ?? item?.repo
    const number = record.number ?? item?.number ?? null
    if (repo === undefined || !repo.includes('/') || number === null || number <= 0 || seen.has(`${repo}#${number}`)) return []
    seen.add(`${repo}#${number}`)
    return [{ repo, number, by: record.name }]
  })
  return found.slice(-MAX_PULL_REQUESTS)
}

/**
 * What the hooks and the transcripts know of each participant's days, and whose pull requests were whose: the optional op `participantMetrics`.
 * Times come from the state log (`team/state-time.ts`), cost and tokens from the transcripts' index, which is read again in the background when it
 * is stale, so a call never waits for the transcripts. A pull request is listed only when the hooks saw its session open it.
 */
export function participantMetrics(request: ParticipantMetricsRequest, deps: RuntimeDeps): { readonly result: ParticipantMetrics } | { readonly error: RuntimeError } {
  const { p, config, now, ports } = deps
  const index = readIndex(p.usageIndex)
  if (index === null || isIndexStale(p, now)) deps.spawnUsageIndex()
  if (index === null) return fail(503, 'the token usage has not been read yet; reading it was started')
  const offsetMinutes = request.utcOffsetMinutes ?? usageOffsetMinutes(config)
  const team = teamNamesOf(config)
  const isTeam = (name: string): boolean => team.has(baseName(name))
  const memberOf = membersBySession(index, sessionNames(p, ports.transcripts), team)
  const usage = dailyUsage({ index, memberOf, days: request.days, now, offsetMinutes })
  const sessions = new Map<string, SessionLife>(
    readHeartbeats(p, now).filter((one) => isTeam(one.name)).map((one) => [one.sessionId, { isAlive: one.isAlive, updatedAt: one.updatedAt, name: one.name, state: one.state, since: one.since }]),
  )
  const times = new Map(
    stateSecondsByMember({ marks: readStateMarks(p.memberStates).filter((mark) => isTeam(mark.name)), sessions, days: request.days, now, offsetMinutes }).map((one) => [one.name, one.byDay]),
  )
  const dates = lastDates(request.days, now, offsetMinutes)
  const participants = [...new Set([...times.keys(), ...usage.keys()])].toSorted().flatMap((name) => {
    const seconds = new Map((times.get(name) ?? []).map((day) => [day.date, day]))
    const used = new Map((usage.get(name) ?? []).map((day) => [day.date, day]))
    const byDay = dates.map((date): ParticipantDay => ({
      date,
      busySeconds: seconds.get(date)?.busySeconds ?? 0,
      waitingSeconds: seconds.get(date)?.waitingSeconds ?? 0,
      idleSeconds: seconds.get(date)?.idleSeconds ?? 0,
      costUsd: used.get(date)?.costUsd ?? 0,
      tokens: used.get(date)?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }))
    const days = byDay.filter((day) => !isEmptyDay(day))
    return days.length === 0 ? [] : [{ name, byDay: days }]
  })
  const pullRequests = pullRequestsOf(readPrAuthorRecords(p.prAuthors), loadSnapshot(p))
  return { result: { org: request.org, team: request.team, days: request.days, generatedAt: now.toISOString(), utcOffsetMinutes: offsetMinutes, participants, pullRequests } }
}
