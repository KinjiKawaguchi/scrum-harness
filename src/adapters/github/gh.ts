import { execFileSync } from 'node:child_process'

/** Calls gh and returns standard output. Throws on failure. Tests pass a fake of the same shape. */
export type GhRun = (args: readonly string[]) => string

/**
 * Standard error is not passed through to the parent but is carried by the exception that is thrown. If it were passed through, gh's failure text would get mixed into the
 * text that the watch process raises (asyncRewake reads stderr as text).
 */
const GH_STDIO: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']

function runGh(args: readonly string[], timeoutMs: number): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, stdio: GH_STDIO })
}

/** Calls gh and returns standard output. Throws on failure. */
export function gh(args: readonly string[]): string {
  return runGh(args, 120_000)
}

/** A gh with limited time. Used where it is called while holding the lock (so that a slow call does not make other people's handovers wait). */
export function ghWithin(timeoutMs: number): GhRun {
  return (args) => runGh(args, timeoutMs)
}
