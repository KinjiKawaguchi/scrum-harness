import { spawnSync } from 'node:child_process'
import type { FundingConfig } from '../../members/config.ts'
import { expandHome } from '../../paths.ts'
import type { FundingLister, FundingPick, FundingPicker, FundingSource } from '../../ports/index.ts'
import { assertTrustedFile } from '../module/load.ts'

/** A pick that takes longer than this is not waited for: the member then starts on its own settings. */
const PICK_TIMEOUT_MS = 20_000

/** The environment variables a pick may set: where a session keeps its login. Anything else the program names is refused, so it cannot set PATH or a loader. */
const ALLOWED_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const
const STATES = ['ok', 'unknown', 'overThreshold', 'none'] as const

const cut = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300)

function envOf(env: unknown): Record<string, string> {
  const entries = Object.entries(typeof env === 'object' && env !== null ? env : {})
  const bad = entries.find(([key, one]) => !(ALLOWED_ENV as readonly string[]).includes(key) || typeof one !== 'string' || one === '')
  if (bad !== undefined) throw new Error(`its env names ${bad[0]}, and only ${ALLOWED_ENV.join(' and ')} may be set, to text`)
  return Object.fromEntries(entries) as Record<string, string>
}

function jsonOf(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`it did not answer with JSON: ${cut(stdout)}`)
  }
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

/** Runs the funding program with `words` after its own first arguments; its output and exit status. Throws when it cannot be run or ends in a way no answer allows. */
function runFunding(config: FundingConfig, words: readonly string[], okStatuses: readonly number[]): string {
  const [first = '', ...leading] = config.command
  const file = assertTrustedFile(expandHome(first), 'funding program')
  const args = [...leading, ...words, ...(config.dir === undefined ? [] : ['--dir', expandHome(config.dir)])]
  const run = spawnSync(file, args, { encoding: 'utf8', timeout: PICK_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
  if (run.error !== undefined) throw new Error(`${file} did not answer: ${cut(run.error.message)}`)
  if (run.status === null || !okStatuses.includes(run.status)) throw new Error(`${file} failed (exit ${run.status ?? '?'}): ${cut(run.stderr || run.stdout)}`)
  return `${run.status}\n${run.stdout}`
}

const split = (output: string): { readonly status: number; readonly stdout: string } => ({ status: Number(output.slice(0, output.indexOf('\n'))), stdout: output.slice(output.indexOf('\n') + 1) })

/**
 * Asks `agency funding pick` which account a session of a tool should run under: one JSON object on stdout, exit 0 for `ok`, `unknown`, and
 * `overThreshold`, and 3 for `none` (which is an answer, not a failure). The program is a file of the user that others cannot write, and the answer's
 * environment is limited to where a login lives. Throws, with the program's own words, when it cannot answer.
 */
export function agencyFundingPicker(config: FundingConfig): FundingPicker {
  return (tool) => {
    const { status, stdout } = split(runFunding(config, ['pick', '--tool', tool], [0, 3]))
    const pick = answerOf(stdout)
    if (status === 3 && pick.state !== 'none') throw new Error('it exited 3 but did not answer none')
    return pick
  }
}

/** Asks `agency funding list`: a JSON array of `{ source, tool, env }`. Throws, with the program's own words, when it cannot answer. */
export function agencyFundingLister(config: FundingConfig): FundingLister {
  return () => {
    const list = jsonOf(split(runFunding(config, ['list'], [0])).stdout)
    if (!Array.isArray(list)) throw new Error('it did not answer a list')
    return list.map((one: unknown): FundingSource => {
      const { source, tool, env } = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>
      if (typeof source !== 'string' || source === '' || (tool !== 'claude' && tool !== 'codex')) throw new Error('a source in its list has no name, or a tool that is not claude or codex')
      return { source, tool, env: envOf(env) }
    })
  }
}
