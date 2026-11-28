import { execFileSync } from 'node:child_process'
import type { Guard } from './limit-guard.ts'

/** Calls gh and returns standard output. Throws on failure. Tests pass a fake of the same shape. */
export type GhRun = (args: readonly string[]) => string

/**
 * Standard error is not passed through to the parent but is carried by the exception that is thrown. If it were passed through, gh's failure text would get mixed into the
 * text that the watch process raises (asyncRewake reads stderr as text).
 */
const GH_STDIO: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']

/**
 * The environment a gh call (or a board script that calls gh) runs in. With a host (a GitHub Enterprise host name), GH_HOST points gh at it,
 * for `gh api`, `gh project`, and `-R owner/repo` alike. Without one, gh's own default applies.
 */
export function ghEnv(host: string | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return host === undefined ? base : { ...base, GH_HOST: host }
}

function runGh(args: readonly string[], timeoutMs: number, host: string | undefined): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, stdio: GH_STDIO, env: ghEnv(host) })
}

/** The gh calls for one host: the usual one, and one with limited time (used where it is called while holding the lock, so that a slow call does not make other people's handovers wait). */
export type GhClient = { readonly run: GhRun; readonly within: (timeoutMs: number) => GhRun }

/** What a failed call says: gh's words on standard error, and what it printed before it failed. */
function failureText(error: unknown): string {
  const { stderr, stdout } = error as { stderr?: unknown; stdout?: unknown }
  return [stderr, stdout, error instanceof Error ? error.message : String(error)].filter((part): part is string => typeof part === 'string').join('\n')
}

/** A call that the guard sees before and after, and refuses while GitHub's limit holds. The failure is the call's own, as it was without the guard. */
export function guarded(call: GhRun, guard: Guard): GhRun {
  return (args) => {
    guard.before(args)
    try {
      const stdout = call(args)
      guard.after(args, { ok: true, stdout })
      return stdout
    } catch (error) {
      guard.after(args, { ok: false, text: failureText(error) })
      throw error
    }
  }
}

/** `makeGuard` is given the unguarded call and returns what watches the calls; without one, nothing does. */
export function ghFor(host: string | undefined, makeGuard?: (raw: GhRun) => Guard): GhClient {
  const guard = makeGuard?.((args) => runGh(args, 20_000, host))
  const call = (timeoutMs: number): GhRun => (guard === undefined ? (args) => runGh(args, timeoutMs, host) : guarded((args) => runGh(args, timeoutMs, host), guard))
  return { run: call(120_000), within: call }
}

/** Calls gh and returns standard output. Throws on failure. */
export const gh: GhRun = ghFor(undefined).run

/** A gh with limited time. */
export const ghWithin = ghFor(undefined).within
