import { spawnSync } from 'node:child_process'
import { expandHome } from '../../paths.ts'
import { assertTrustedFile } from '../module/load.ts'

/** A program that takes longer than this is not waited for. */
const TIMEOUT_MS = 20_000

/** The node's program as a setting names it: an absolute path, then the arguments that come before the harness's own, and optionally the node's data directory. */
export type AgencyProgram = { readonly command: readonly string[]; readonly dir?: string }

export const cut = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300)

/**
 * Runs the node's program with `words` after its own first arguments (and `--dir`, when set). The program is a file of the user that others cannot write.
 * Throws, with its own words, when it cannot be run or ends with a status that is not in `okStatuses`.
 */
export function runAgency(program: AgencyProgram, words: readonly string[], okStatuses: readonly number[]): { readonly status: number; readonly stdout: string } {
  const [first = '', ...leading] = program.command
  const file = assertTrustedFile(expandHome(first), 'node program')
  const args = [...leading, ...words, ...(program.dir === undefined ? [] : ['--dir', expandHome(program.dir)])]
  const run = spawnSync(file, args, { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 })
  if (run.error !== undefined) throw new Error(`${file} did not answer: ${cut(run.error.message)}`)
  if (run.status === null || !okStatuses.includes(run.status)) throw new Error(`${file} failed (exit ${run.status ?? '?'}): ${cut(run.stderr || run.stdout)}`)
  return { status: run.status, stdout: run.stdout }
}

export function jsonOf(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`it did not answer with JSON: ${cut(stdout)}`)
  }
}
