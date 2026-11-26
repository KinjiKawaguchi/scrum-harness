import { participantMetrics } from '../agency-runtime/participant-metrics.ts'
import { runtimeOf } from '../agency-runtime/config.ts'
import type { RuntimeDeps } from '../agency-runtime/handle.ts'
import { MAX_USAGE_DAYS, RUNTIME_VERSION } from '../agency-runtime/types.ts'
import type { Config } from '../config.ts'
import type { Flags } from '../cli-commands.ts'
import { formatParticipantMetrics } from './participants-text.ts'

const DEFAULT_DAYS = 7

/** `scrum metrics`: the report the op `participantMetrics` answers, for people (or as the op's JSON with --json). */
export function metricsCommand(config: Config, flags: Flags, deps: Omit<RuntimeDeps, 'config'>): string {
  const days = typeof flags.days === 'string' ? Number(flags.days) : DEFAULT_DAYS
  if (!Number.isInteger(days) || days < 1 || days > MAX_USAGE_DAYS) return `--days must be a whole number from 1 to ${MAX_USAGE_DAYS}`
  const team = runtimeOf(config).label ?? 'team'
  const answer = participantMetrics({ runtime: RUNTIME_VERSION, org: 'local', team, op: 'participantMetrics', days }, { ...deps, config })
  if ('error' in answer) return `${answer.error.message} (run it again in a minute)`
  return flags.json === true ? JSON.stringify(answer.result, null, 1) : formatParticipantMetrics(answer.result)
}
