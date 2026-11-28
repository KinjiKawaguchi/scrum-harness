import { SMALL_QUERY_POINTS, activeBackoff, clearBackoff, readBackoff, recordUse, writeBackoff } from '../../board/graphql-use.ts'
import type { GhRun } from './gh.ts'

/** What a call of gh did: what it printed, or the words it failed with. */
export type Outcome = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly text: string }

/** Watches the calls of gh that spend GraphQL points: counts them, and stops them while GitHub has said to wait. */
export type Guard = {
  /** Throws GithubLimited when the harness is waiting for GitHub's GraphQL limit to lift. */
  readonly before: (args: readonly string[]) => void
  readonly after: (args: readonly string[], outcome: Outcome) => void
}

/** Thrown, without calling GitHub, for a GraphQL call made while GitHub's limit holds. */
export class GithubLimited extends Error {
  readonly until: Date
  constructor(until: Date, reason: string) {
    super(`GitHub's GraphQL allowance is not available until ${until.toISOString().slice(11, 16)} UTC (${reason}); the harness waits instead of asking again`)
    this.name = 'GithubLimited'
    this.until = until
  }
}

/** The gh commands that go through GraphQL, whatever their words: `gh api graphql`, and the commands gh itself builds on it. */
const GRAPHQL_COMMANDS = new Set(['issue', 'pr', 'project', 'repo'])

export const isGraphqlCall = (args: readonly string[]): boolean => (args[0] === 'api' && args.includes('graphql')) || GRAPHQL_COMMANDS.has(args[0] ?? '')

/** A short name for a call, to tell what the points went on: `graphql node`, `issue list`. */
export function whatOf(args: readonly string[]): string {
  if (args[0] !== 'api') return `${args[0] ?? ''} ${args[1] ?? ''}`.trim()
  const query = args.find((one) => one.startsWith('query='))?.slice('query='.length) ?? ''
  const first = /^\s*(?:query|mutation)\s*(?:\([^)]*\))?\s*\{\s*(?:rateLimit\s*\{[^}]*\}\s*)?(?:\w+\s*:\s*)?(\w+)/.exec(query)?.[1]
  return first === undefined ? 'graphql' : `graphql ${first}`
}

/** The points a call cost, when its answer says (every `rateLimit.cost` in it, a page each), else what a small query is counted as. */
export function pointsOf(stdout: string): number {
  try {
    const value: unknown = JSON.parse(stdout)
    const pages = Array.isArray(value) ? value : [value]
    const costs = pages.flatMap((page) => {
      const cost = (page as { data?: { rateLimit?: { cost?: unknown } | null } | null } | null)?.data?.rateLimit?.cost
      return typeof cost === 'number' ? [cost] : []
    })
    return costs.length === 0 ? SMALL_QUERY_POINTS : costs.reduce((sum, one) => sum + one, 0)
  } catch {
    return SMALL_QUERY_POINTS
  }
}

export type LimitKind = 'secondary' | 'primary'

/** Whether the words of a failed call say that GitHub's limit stopped it, and which limit. */
export function limitKindOf(text: string): LimitKind | null {
  if (/secondary rate limit|abuse detection/i.test(text)) return 'secondary'
  if (/API rate limit (already )?exceeded|rate limit exceeded|RATE_LIMITED/i.test(text)) return 'primary'
  return null
}

/** The seconds GitHub asked to wait, when its words say them. */
export function retryAfterSeconds(text: string): number | null {
  const found = /retry-after\D{0,3}(\d+)|try again in (\d+) seconds?/i.exec(text)
  const seconds = Number(found?.[1] ?? found?.[2])
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

const MIN_WAIT_SECONDS = 60
const MOST_WAIT_SECONDS = 15 * 60
/** When the points reset cannot be asked, the wait for a primary limit. */
const UNKNOWN_RESET_SECONDS = 10 * 60

export type GuardOptions = {
  /** The directory the teams of a machine share; null turns the guard off (nothing counted, nothing held back) */
  readonly directory: string | null
  readonly team: string
  /** Runs gh without the guard, to ask `rate_limit` (which costs no points) when the points reset */
  readonly raw: GhRun
  readonly now?: () => Date
}

function resetOf(raw: GhRun): Date | null {
  try {
    const seconds = Number(raw(['api', 'rate_limit', '--jq', '.resources.graphql.reset']).trim())
    return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null
  } catch {
    return null
  }
}

/**
 * Counts what the harness spends of the account's GraphQL points, and backs off when GitHub says to: a secondary limit waits as long as GitHub asks (else a
 * minute, doubling while it goes on, up to a quarter of an hour), the hour's points used up wait for their reset. A call made during the wait is refused
 * here, without asking GitHub, since asking again is what the limit punishes.
 */
export function limitGuard(options: GuardOptions): Guard {
  const { directory, team } = options
  const now = options.now ?? (() => new Date())
  if (directory === null) return { before: () => undefined, after: () => undefined }
  return {
    before: (args) => {
      if (!isGraphqlCall(args)) return
      const waiting = activeBackoff(readBackoff(directory), now())
      if (waiting !== null) throw new GithubLimited(new Date(waiting.until), waiting.reason)
    },
    after: (args, outcome) => {
      if (!isGraphqlCall(args)) return
      const at = now()
      if (outcome.ok) {
        recordUse(directory, { at: at.toISOString(), team, what: whatOf(args), points: pointsOf(outcome.stdout) }, at)
        if (readBackoff(directory) !== null) clearBackoff(directory)
        return
      }
      const kind = limitKindOf(outcome.text)
      if (kind === null) return
      const streak = (readBackoff(directory)?.streak ?? 0) + 1
      const asked = retryAfterSeconds(outcome.text)
      const reset = kind === 'primary' ? resetOf(options.raw) : null
      const seconds = kind === 'primary' ? Math.max(MIN_WAIT_SECONDS, reset === null ? UNKNOWN_RESET_SECONDS : Math.ceil((reset.getTime() - at.getTime()) / 1000) + 5) : Math.min(MOST_WAIT_SECONDS, asked ?? MIN_WAIT_SECONDS * 2 ** (streak - 1))
      writeBackoff(directory, { until: new Date(at.getTime() + seconds * 1000).toISOString(), reason: kind === 'primary' ? 'the hour\'s GraphQL points are used up' : 'GitHub\'s secondary limit', streak })
    },
  }
}
