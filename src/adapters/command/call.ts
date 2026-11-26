import { spawnSync } from 'node:child_process'
import type { AdapterCommandConfig } from '../../adapter-module.ts'
import { expandHome } from '../../paths.ts'
import { assertTrustedFile } from '../module/load.ts'

/** The version of the contract between the harness and a tracker program. Every request names it. */
export const BOARD_PROTOCOL = 'scrum-board/1'

const MAX_OUTPUT = 64 * 1024 * 1024

const cut = (text: string, length = 300): string => text.replace(/\s+/g, ' ').trim().slice(0, length)

/**
 * Runs the tracker program once: one JSON request on stdin, one JSON answer on stdout (`{"result": ...}`, or `{"error": {"message": ...}}`).
 * The program is a file of the user that is not writable by others (it runs with this process's privileges). Throws, with the program's own message,
 * when it fails, times out, or answers something that is not an answer. The request is never put in a message.
 */
export function callBoardProgram(spec: AdapterCommandConfig, request: Readonly<Record<string, unknown>>): unknown {
  const [first = '', ...args] = spec.command
  const file = assertTrustedFile(expandHome(first))
  const run = spawnSync(file, args, {
    input: JSON.stringify({ board: BOARD_PROTOCOL, options: spec.options, ...request }),
    encoding: 'utf8',
    timeout: spec.timeoutSeconds * 1000,
    maxBuffer: MAX_OUTPUT,
  })
  if (run.error !== undefined) throw new Error(`the board program ${file} did not answer: ${cut(run.error.message)}`)
  let answer: unknown
  try {
    answer = JSON.parse(run.stdout)
  } catch {
    throw new Error(`the board program ${file} did not answer with JSON (exit ${run.status ?? '?'}): ${cut(run.stderr || run.stdout)}`)
  }
  const { result, error } = (typeof answer === 'object' && answer !== null ? answer : {}) as { result?: unknown; error?: { message?: unknown } }
  if (error !== undefined) throw new Error(`the board program ${file} refused ${String(request.op)}: ${cut(typeof error?.message === 'string' ? error.message : JSON.stringify(error))}`)
  if (result === undefined || run.status !== 0) throw new Error(`the board program ${file} gave no result for ${String(request.op)} (exit ${run.status ?? '?'})`)
  return result
}
