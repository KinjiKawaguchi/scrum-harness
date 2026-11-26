import { execFileSync } from 'node:child_process'

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

export function ghFor(host: string | undefined): GhClient {
  return { run: (args) => runGh(args, 120_000, host), within: (timeoutMs) => (args) => runGh(args, timeoutMs, host) }
}

/** Calls gh and returns standard output. Throws on failure. */
export const gh: GhRun = ghFor(undefined).run

/** A gh with limited time. */
export const ghWithin = ghFor(undefined).within
