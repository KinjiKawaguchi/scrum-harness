import type { SessionSignal } from '../team/types.ts'
import { baseName } from '../usage/attribution.ts'
import type { MemberSpec } from './config.ts'

/** How long a Codex member has to show a sign of life, when its settings do not say. */
export const DEFAULT_CODEX_STARTUP_SECONDS = 60
export const DEFAULT_STARTUP_RETRIES = 2

/** How often a waiting watchdog looks for the sign of life, in milliseconds. */
const POLL_MS = 2000

export type Watchdog = { readonly seconds: number; readonly retries: number }

/** The member's watchdog: the settings, with the defaults of its product. Null when it has none. */
export function watchdogOf(spec: MemberSpec): Watchdog | null {
  const seconds = spec.startupSeconds ?? (spec.product === 'codex' ? DEFAULT_CODEX_STARTUP_SECONDS : undefined)
  return seconds === undefined ? null : { seconds, retries: spec.startupRetries ?? DEFAULT_STARTUP_RETRIES }
}

/** A sign of life: a live session of that name that has been heard from since `since` (its hook heartbeat, or its session record). */
export function showsLife(signals: readonly SessionSignal[], name: string, since: Date): boolean {
  return signals.some((signal) => signal.isAlive && signal.state !== 'ended' && baseName(signal.name) === name && Date.parse(signal.updatedAt) >= since.getTime())
}

export type WaitDeps = {
  readonly signals: () => readonly SessionSignal[]
  readonly now: () => Date
  readonly sleep: (milliseconds: number) => void
}

/** Waits up to `seconds` for the member to show a sign of life. Returns as soon as it does. */
export function waitForLife(name: string, since: Date, seconds: number, deps: WaitDeps): boolean {
  const deadline = since.getTime() + seconds * 1000
  for (;;) {
    if (showsLife(deps.signals(), name, since)) return true
    if (deps.now().getTime() >= deadline) return false
    deps.sleep(POLL_MS)
  }
}
