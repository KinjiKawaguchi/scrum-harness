import type { Config } from '../config.ts'
import { dispatchOf } from '../config.ts'
import { alertsOf } from './config.ts'
import { clock, spanText } from './text.ts'
import type { AlertState, Notice } from './types.ts'

/** The suffix of the fingerprint of a notification reduced to one line that is only for the liaison to read. It is remembered separately from the original notification's fingerprint. */
const HELD_SUFFIX = ':held'

function isSent(state: AlertState, key: string): boolean {
  return state.desktopSent.includes(key) || state.liaisonSent.includes(key)
}

function held(notice: Notice, lastAt: string, config: Config): Notice {
  const throttle = notice.throttle
  const span = spanText(throttle?.minutes ?? 0)
  const when = clock(lastAt, dispatchOf(config).utcOffset)
  const head = throttle?.head ?? notice.key
  return {
    key: `${notice.key}${HELD_SUFFIX}`,
    kind: 'info',
    text: `- ${head}: ${config.ownerLabel} was already notified at ${when}, and the same subject is sent at most once per ${span}, so it is not sent this time (${throttle?.detail ?? ''})`,
  }
}

/**
 * Limits notifications to the owner about the same target (Epic) to once per epicPushMinutes. A notification with a new fingerprint after the last notification
 * is replaced by one line only for the liaison to read (no macOS notification is shown either). A notification with an already shown fingerprint is left as is.
 * If the same state continues after the interval has passed, the new notification at that time goes out to the owner.
 */
export function applyThrottle(notices: readonly Notice[], state: AlertState, config: Config, now: Date): readonly Notice[] {
  return notices.map((notice) => {
    const last = notice.throttle === undefined ? undefined : state.ownerPushedAt[notice.throttle.key]
    const window = (notice.throttle?.minutes ?? 0) * 60_000
    if (last === undefined || isSent(state, notice.key) || now.getTime() - Date.parse(last) >= window) return notice
    return held(notice, last, config)
  })
}

/** A notification to the owner, for a target with an interval, that is being shown for the first time now. Used to remember the time it was shown. */
export function newlyPushed(notices: readonly Notice[], state: AlertState): readonly Notice[] {
  return notices.filter((notice) => notice.kind === 'owner' && notice.throttle !== undefined && !isSent(state, notice.key))
}

/** Remembers the time of notification. Those older than the interval are dropped. */
export function recordPushed(
  state: AlertState,
  pushed: readonly Notice[],
  config: Config,
  now: Date,
): Readonly<Record<string, string>> {
  const alerts = alertsOf(config)
  const window = Math.max(alerts.epicPushMinutes, alerts.emptyPushMinutes) * 60_000
  const next = { ...state.ownerPushedAt, ...Object.fromEntries(pushed.flatMap((notice) => (notice.throttle === undefined ? [] : [[notice.throttle.key, now.toISOString()]]))) }
  return Object.fromEntries(Object.entries(next).filter(([, at]) => now.getTime() - Date.parse(at) < window))
}
