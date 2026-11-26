import { participantMetrics } from '../agency-runtime/participant-metrics.ts'
import { runtimeOf } from '../agency-runtime/config.ts'
import type { RuntimeDeps } from '../agency-runtime/handle.ts'
import { MAX_USAGE_DAYS, RUNTIME_VERSION } from '../agency-runtime/types.ts'
import type { Config } from '../config.ts'
import { offsetMinutes } from '../dispatch/idle-ack.ts'
import type { Flags } from '../cli-commands.ts'
import { formatParticipantMetrics } from './participants-text.ts'

const DEFAULT_DAYS = 7
const OFFSET = /^[+-]\d{2}:\d{2}$/

/**
 * The time zone a person's report cuts days in, as minutes east of UTC: `--utc-offset +09:00` when given, else the team's own setting (`runtime.utcOffset`,
 * then the sprint's), else this machine's, since a person reads the days of the place they are in. (The op itself, with no offset from the node, uses the
 * team's setting and then UTC, as `tokenUsage` does.)
 */
export function reportOffset(config: Config, flags: Flags, now: Date): number | string {
  if (typeof flags['utc-offset'] === 'string') return OFFSET.test(flags['utc-offset']) ? offsetMinutes(flags['utc-offset']) : '--utc-offset must look like +09:00'
  const set = runtimeOf(config).utcOffset ?? config.sprint?.utcOffset
  return set === undefined ? -now.getTimezoneOffset() : offsetMinutes(set)
}

/** `scrum metrics`: the report the op `participantMetrics` answers, for people (or as the op's JSON with --json). */
export function metricsCommand(config: Config, flags: Flags, deps: Omit<RuntimeDeps, 'config'>): string {
  const days = typeof flags.days === 'string' ? Number(flags.days) : DEFAULT_DAYS
  if (!Number.isInteger(days) || days < 1 || days > MAX_USAGE_DAYS) return `--days must be a whole number from 1 to ${MAX_USAGE_DAYS}`
  const utcOffsetMinutes = reportOffset(config, flags, deps.now)
  if (typeof utcOffsetMinutes === 'string') return utcOffsetMinutes
  const team = runtimeOf(config).label ?? 'team'
  const answer = participantMetrics({ runtime: RUNTIME_VERSION, org: 'local', team, op: 'participantMetrics', days, utcOffsetMinutes }, { ...deps, config })
  if ('error' in answer) return `${answer.error.message} (run it again in a minute)`
  return flags.json === true ? JSON.stringify(answer.result, null, 1) : formatParticipantMetrics(answer.result)
}
