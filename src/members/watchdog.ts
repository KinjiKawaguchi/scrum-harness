import type { SessionSignal } from '../team/types.ts'
import { baseName } from '../usage/attribution.ts'
import type { MemberSpec } from './config.ts'

/** How long a Codex member has to show a sign of life, when its settings do not say. */
export const DEFAULT_CODEX_STARTUP_SECONDS = 60
export const DEFAULT_STARTUP_RETRIES = 2
/** A Claude Code member that is to have its trust question answered is watched, so that the answer has someone to give it. */
export const DEFAULT_CLAUDE_TRUST_STARTUP_SECONDS = 60

/** How often a waiting watchdog looks for the sign of life, in milliseconds. */
const POLL_MS = 2000

export type Watchdog = { readonly seconds: number; readonly retries: number }

/** The member's watchdog: the settings, with the defaults of its product. Null when it has none. */
export function watchdogOf(spec: MemberSpec): Watchdog | null {
  const seconds = spec.startupSeconds ?? (spec.product === 'codex' ? DEFAULT_CODEX_STARTUP_SECONDS : spec.trustDirectory === true ? DEFAULT_CLAUDE_TRUST_STARTUP_SECONDS : undefined)
  return seconds === undefined ? null : { seconds, retries: spec.startupRetries ?? DEFAULT_STARTUP_RETRIES }
}

/** A sign of life: a live session of that name that has been heard from since `since` (its hook heartbeat, or its session record). */
export function showsLife(signals: readonly SessionSignal[], name: string, since: Date): boolean {
  return signals.some((signal) => signal.isAlive && signal.state !== 'ended' && baseName(signal.name) === name && Date.parse(signal.updatedAt) >= since.getTime())
}

/** The sign that a member's session ended: its hook recorded the end since `since`. */
export function showsEnd(signals: readonly SessionSignal[], name: string, since: Date): boolean {
  return signals.some((signal) => signal.state === 'ended' && baseName(signal.name) === name && Date.parse(signal.updatedAt) >= since.getTime())
}

export type WaitDeps = {
  readonly signals: () => readonly SessionSignal[]
  readonly now: () => Date
  readonly sleep: (milliseconds: number) => void
}

/** Waits up to `seconds` for the member to show a sign of life, calling `onPoll` at each look. Returns as soon as it does. */
export function waitForLife(name: string, since: Date, seconds: number, deps: WaitDeps, onPoll: () => void = () => undefined): boolean {
  const deadline = since.getTime() + seconds * 1000
  for (;;) {
    if (showsLife(deps.signals(), name, since)) return true
    if (deps.now().getTime() >= deadline) return false
    onPoll()
    deps.sleep(POLL_MS)
  }
}

/** Waits up to `seconds` for `done()` to be true, looking every 2 seconds. */
export function waitUntil(done: () => boolean, seconds: number, deps: Pick<WaitDeps, 'now' | 'sleep'>): boolean {
  const deadline = deps.now().getTime() + seconds * 1000
  for (;;) {
    if (done()) return true
    if (deps.now().getTime() >= deadline) return false
    deps.sleep(POLL_MS)
  }
}

/** The last few lines of a window, for a message: blank lines dropped, each cut short. Null when there is nothing on it. */
export function screenSummary(screen: string | null, lines = 6): string | null {
  const shown = (screen ?? '').split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line !== '').slice(-lines).map((line) => line.slice(0, 120))
  return shown.length === 0 ? null : shown.join(' | ')
}
