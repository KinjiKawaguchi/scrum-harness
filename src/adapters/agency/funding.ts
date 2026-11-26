import { spawnSync } from 'node:child_process'
import type { FundingConfig } from '../../members/config.ts'
import { expandHome } from '../../paths.ts'
import type { FundingPick, FundingPicker } from '../../ports/index.ts'
import { assertTrustedFile } from '../module/load.ts'

/** A pick that takes longer than this is not waited for: the member then starts on its own settings. */
const PICK_TIMEOUT_MS = 20_000

/** The environment variables a pick may set: where a session keeps its login. Anything else the program names is refused, so it cannot set PATH or a loader. */
const ALLOWED_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const
const STATES = ['ok', 'unknown', 'overThreshold', 'none'] as const

const cut = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300)

function answerOf(stdout: string): FundingPick {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error(`it did not answer with JSON: ${cut(stdout)}`)
  }
  const { state, source, env, reason } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  if (!(STATES as readonly unknown[]).includes(state)) throw new Error(`its state is not one of ${STATES.join(', ')}`)
  const entries = Object.entries(typeof env === 'object' && env !== null ? env : {})
  const bad = entries.find(([key, one]) => !(ALLOWED_ENV as readonly string[]).includes(key) || typeof one !== 'string' || one === '')
  if (bad !== undefined) throw new Error(`its env names ${bad[0]}, and only ${ALLOWED_ENV.join(' and ')} may be set, to text`)
  return {
    state: state as FundingPick['state'],
    ...(typeof source === 'string' && source !== '' ? { source } : {}),
    env: Object.fromEntries(entries) as Record<string, string>,
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
    const [first = '', ...leading] = config.command
    const file = assertTrustedFile(expandHome(first), 'funding program')
    const args = [...leading, 'pick', '--tool', tool, ...(config.dir === undefined ? [] : ['--dir', expandHome(config.dir)])]
    const run = spawnSync(file, args, { encoding: 'utf8', timeout: PICK_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
    if (run.error !== undefined) throw new Error(`${file} did not answer: ${cut(run.error.message)}`)
    if (run.status !== 0 && run.status !== 3) throw new Error(`${file} failed (exit ${run.status ?? '?'}): ${cut(run.stderr || run.stdout)}`)
    const pick = answerOf(run.stdout)
    if (run.status === 3 && pick.state !== 'none') throw new Error('it exited 3 but did not answer none')
    return pick
  }
}
