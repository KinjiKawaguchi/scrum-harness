import type { Config } from '../config.ts'
import { dispatchOf } from '../config.ts'
import { alertsOf } from './config.ts'
import { clock, spanText } from './text.ts'
import type { AlertState, Notice } from './types.ts'

/** 窓口に読ませるだけの 1 行にした通知の指紋の添え字。元の通知の指紋とは別に覚える。 */
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
    text: `- ${head}: ${config.ownerLabel}へは ${when} に通知済みで、同じ対象は ${span}に 1 回までなので、今回は送らない (${throttle?.detail ?? ''})`,
  }
}

/**
 * 同じ対象 (Epic) のオーナーへの通知を、epicPushMinutes に 1 回までにする。直前に通知した後の、新しい指紋の通知は、
 * 窓口に読ませるだけの 1 行に替える (macOS の通知も出さない)。すでに出した指紋の通知は、そのまま。
 * 間隔が過ぎても同じ状態が続いていれば、そのときの新しい通知が、オーナーに出る。
 */
export function applyThrottle(notices: readonly Notice[], state: AlertState, config: Config, now: Date): readonly Notice[] {
  return notices.map((notice) => {
    const last = notice.throttle === undefined ? undefined : state.ownerPushedAt[notice.throttle.key]
    const window = (notice.throttle?.minutes ?? 0) * 60_000
    if (last === undefined || isSent(state, notice.key) || now.getTime() - Date.parse(last) >= window) return notice
    return held(notice, last, config)
  })
}

/** いま初めて出す、間隔を空ける対象のオーナーへの通知。出した時刻を覚えるのに使う。 */
export function newlyPushed(notices: readonly Notice[], state: AlertState): readonly Notice[] {
  return notices.filter((notice) => notice.kind === 'owner' && notice.throttle !== undefined && !isSent(state, notice.key))
}

/** 通知した時刻を覚える。間隔より前のものは捨てる。 */
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
