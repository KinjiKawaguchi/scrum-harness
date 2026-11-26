import type { FundingConfig } from '../../members/config.ts'
import type { FundingLister, FundingPick, FundingPicker, FundingSource } from '../../ports/index.ts'
import { cut, jsonOf, runAgency } from './run.ts'

/** The environment variables a pick may set: where a session keeps its login. Anything else the program names is refused, so it cannot set PATH or a loader. */
const ALLOWED_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const
const STATES = ['ok', 'unknown', 'overThreshold', 'none'] as const

function envOf(env: unknown): Record<string, string> {
  const entries = Object.entries(typeof env === 'object' && env !== null ? env : {})
  const bad = entries.find(([key, one]) => !(ALLOWED_ENV as readonly string[]).includes(key) || typeof one !== 'string' || one === '')
  if (bad !== undefined) throw new Error(`its env names ${bad[0]}, and only ${ALLOWED_ENV.join(' and ')} may be set, to text`)
  return Object.fromEntries(entries) as Record<string, string>
}

function answerOf(stdout: string): FundingPick {
  const value = jsonOf(stdout)
  const { state, source, env, reason } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  if (!(STATES as readonly unknown[]).includes(state)) throw new Error(`its state is not one of ${STATES.join(', ')}`)
  return {
    state: state as FundingPick['state'],
    ...(typeof source === 'string' && source !== '' ? { source } : {}),
    env: envOf(env),
    ...(typeof reason === 'string' && reason !== '' ? { reason: cut(reason) } : {}),
  }
}

/**
 * Asks `agency funding pick` which account a session of a tool should run under: one JSON object on stdout, exit 0 for `ok`, `unknown`, and
 * `overThreshold`, and 3 for `none` (which is an answer, not a failure). The program is a file of the user that others cannot write, and the answer's
 * environment is limited to where a login lives. Throws, with the program's own words, when it cannot answer.
 */
export function agencyFundingPicker(config: FundingConfig): FundingPicker {
  return (tool) => {
    const { status, stdout } = runAgency(config, ['pick', '--tool', tool], [0, 3])
    const pick = answerOf(stdout)
    if (status === 3 && pick.state !== 'none') throw new Error('it exited 3 but did not answer none')
    return pick
  }
}

/** Asks `agency funding list`: a JSON array of `{ source, tool, env }`. Throws, with the program's own words, when it cannot answer. */
export function agencyFundingLister(config: FundingConfig): FundingLister {
  return () => {
    const list = jsonOf(runAgency(config, ['list'], [0]).stdout)
    if (!Array.isArray(list)) throw new Error('it did not answer a list')
    return list.map((one: unknown): FundingSource => {
      const { source, tool, env, overThreshold, blocked, unknown } = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>
      if (typeof source !== 'string' || source === '' || (tool !== 'claude' && tool !== 'codex')) throw new Error('a source in its list has no name, or a tool that is not claude or codex')
      return { source, tool, env: envOf(env), ...(typeof overThreshold === 'boolean' ? { overThreshold } : {}), ...(typeof blocked === 'boolean' ? { blocked } : {}), ...(typeof unknown === 'boolean' ? { unknown } : {}) }
    })
  }
}
