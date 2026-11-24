import type { Config } from '../config.ts'
import { offsetMinutes } from '../dispatch/idle-ack.ts'
import type { Notice } from './types.ts'

export const NOTICE_TITLE = 'scrum-harness'

export function minutesSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 60_000)
}

/** 時差 (offset) の側の時刻 (HH:MM)。 */
export function clock(iso: string, offset: string): string {
  const local = new Date(Date.parse(iso) + offsetMinutes(offset) * 60_000)
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
}

/** 分を、60 で割り切れれば時間、そうでなければ分で書く。 */
export function spanText(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} 時間` : `${minutes} 分`
}

/** 長い題は通知に収まらないので切る。 */
export function shortTitle(title: string): string {
  return title.length > 40 ? `${title.slice(0, 40)}…` : title
}

/**
 * オーナーへの通知。窓口には、そのまま PushNotification で送る本文を渡し、問いを添える対象があれば、
 * 待っている問いの文を 1 行足させる。ハーネスは同じ内容を macOS の通知 (音なし) でも直接出す。
 */
export function ownerNotice(input: {
  readonly key: string
  readonly head: string
  readonly push: string
  readonly waitingLabels: readonly string[]
  /** まとめるときに並べる、1 行の説明 */
  readonly line: string
  /** 同じ対象のオーナーへの通知を、minutes 分に 1 回までにするときの、対象の名前と間隔 (分) */
  readonly throttle?: { readonly key: string; readonly minutes: number }
  readonly config: Config
}): Notice {
  const { key, head, push, waitingLabels, line, throttle, config } = input
  const waiting = waitingLabels.length === 0 ? '' : ` 待っているのは ${waitingLabels.join('、')} です。`
  const addQuestion =
    waitingLabels.length === 0 ? [] : [`  ${config.ownerLabel}の答え待ちだけで止まっている。待っている問いの文を 1 行添える (対象: ${waitingLabels.join('、')})`]
  return {
    key,
    kind: 'owner',
    text: [`- ${head}: ${config.ownerLabel}に PushNotification を 1 通送る (音は鳴らさない。本文は変えない)`, `  「${push}${waiting}」`, ...addQuestion].join('\n'),
    desktop: { title: NOTICE_TITLE, body: `${push}${waiting}` },
    owner: { line, waiting: waitingLabels },
    ...(throttle === undefined ? {} : { throttle: { ...throttle, head, detail: `${push}${waiting}` } }),
  }
}
