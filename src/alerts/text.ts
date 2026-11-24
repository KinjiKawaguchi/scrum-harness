import type { Config } from '../config.ts'
import { offsetMinutes } from '../dispatch/idle-ack.ts'
import type { Notice } from './types.ts'

export const NOTICE_TITLE = 'scrum-harness'

export function minutesSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 60_000)
}

/** The time (HH:MM) on the offset's side. */
export function clock(iso: string, offset: string): string {
  const local = new Date(Date.parse(iso) + offsetMinutes(offset) * 60_000)
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
}

/** Writes minutes as hours if divisible by 60, otherwise as minutes. */
export function spanText(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`
}

/** A long title does not fit in a notification, so it is cut. */
export function shortTitle(title: string): string {
  return title.length > 40 ? `${title.slice(0, 40)}…` : title
}

/**
 * The notification to the owner. The liaison is given the body to send as is via PushNotification, and when there is a target to attach a question to,
 * it has one line added for the pending question's text. The harness also shows the same content directly as a macOS notification (silent).
 */
export function ownerNotice(input: {
  readonly key: string
  readonly head: string
  readonly push: string
  readonly waitingLabels: readonly string[]
  /** One-line description lined up when combining */
  readonly line: string
  /** The target's name and the interval (minutes) for limiting notifications to the owner about the same target to once per minutes */
  readonly throttle?: { readonly key: string; readonly minutes: number }
  readonly config: Config
}): Notice {
  const { key, head, push, waitingLabels, line, throttle, config } = input
  const waiting = waitingLabels.length === 0 ? '' : ` Waiting on: ${waitingLabels.join(', ')}.`
  const addQuestion =
    waitingLabels.length === 0 ? [] : [`  Blocked only on ${config.ownerLabel}'s answer. Add one line with the pending question (subjects: ${waitingLabels.join(', ')})`]
  return {
    key,
    kind: 'owner',
    text: [`- ${head}: send ${config.ownerLabel} one PushNotification (no sound; do not change the text)`, `  "${push}${waiting}"`, ...addQuestion].join('\n'),
    desktop: { title: NOTICE_TITLE, body: `${push}${waiting}` },
    owner: { line, waiting: waitingLabels },
    ...(throttle === undefined ? {} : { throttle: { ...throttle, head, detail: `${push}${waiting}` } }),
  }
}
