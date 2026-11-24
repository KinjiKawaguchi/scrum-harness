import type { Config } from '../config.ts'
import { dispatchOf } from '../config.ts'
import type { Ack } from '../findings/acks.ts'

/** T-IDLE の受け入れの最長。これより長くは黙らせない。 */
export const IDLE_ACK_MAX_MS = 60 * 60_000

/** 「枠」の受け入れは、枠の始まりのこの時間前までは、自動で渡すのを止めない。 */
export const SLOT_LEAD_MS = 15 * 60_000

const SLOT = /^枠 ([01]\d|2[0-3]):([0-5]\d)$/

export type IdleAckCheck = { readonly ok: true; readonly slotAt: string | null } | { readonly ok: false; readonly message: string }

export function offsetMinutes(offset: string): number {
  const sign = offset.startsWith('-') ? -1 : 1
  const [hours = '0', minutes = '0'] = offset.slice(1).split(':')
  return sign * (Number(hours) * 60 + Number(minutes))
}

/** now と同じ日 (時差の側の日付) の、その時刻の瞬間。 */
function clockOnSameDay(now: Date, hour: number, minute: number, offset: string): number {
  const shift = offsetMinutes(offset) * 60_000
  const local = new Date(now.getTime() + shift)
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - shift
}

/**
 * 枠の始まりの瞬間。今日のその時刻が 1 時間より前なら、終わった枠とみなして明日のその時刻にする。
 * 過去 1 時間以内なら、いまが枠の中なので、今日のその時刻のままにする。
 */
export function slotInstant(now: Date, hour: number, minute: number, offset: string): Date {
  const today = clockOnSameDay(now, hour, minute, offset)
  return new Date(today < now.getTime() - IDLE_ACK_MAX_MS ? today + 86_400_000 : today)
}

/**
 * 保存された T-IDLE の受け入れが、作るときの検査 (checkIdleAck) を通る形か。最長 1 時間 (期限 - 作った時刻)、理由は完全一致の
 * 「<オーナー>の答え待ち」か、枠の始まりを持つ「枠 HH:MM」。検査を入れる前に作られた受け入れ (長い期限、余力などの理由、
 * 理由の後ろに文字がある) は通らず、自動で渡すのも、T-IDLE の指摘も止めない。T-IDLE 以外の受け入れは見ない。
 */
export function isValidIdleAck(ack: Ack, config: Config): boolean {
  if (ack.rule !== 'T-IDLE') return true
  const length = Date.parse(ack.until) - Date.parse(ack.at)
  if (!(length <= IDLE_ACK_MAX_MS)) return false
  if (ack.reason === `${config.ownerLabel}の答え待ち`) return true
  return SLOT.test(ack.reason) && ack.slotAt !== undefined
}

/**
 * T-IDLE の受け入れを検査する。理由は決まった言葉から選ぶ (オーナーの答え待ち、枠 HH:MM)。
 * コンテキストの余力は理由にできない。長さは最長 1 時間。
 */
export function checkIdleAck(input: { readonly reason: string; readonly durationMs: number; readonly now: Date; readonly config: Config }): IdleAckCheck {
  const { reason, durationMs, now, config } = input
  const answerWait = `${config.ownerLabel}の答え待ち`
  if (durationMs > IDLE_ACK_MAX_MS) return { ok: false, message: 'T-IDLE の受け入れは最長 1 時間 (--for 1h まで)' }
  if (reason === answerWait) return { ok: true, slotAt: null }
  const slot = SLOT.exec(reason)
  if (slot !== null) {
    const at = slotInstant(now, Number(slot[1]), Number(slot[2]), dispatchOf(config).utcOffset)
    const lead = at.getTime() - now.getTime()
    if (lead > IDLE_ACK_MAX_MS + SLOT_LEAD_MS) return { ok: false, message: '枠は 1 時間 15 分以内の時刻にする (枠の 15 分前から、自動で渡すのを止める)' }
    return { ok: true, slotAt: at.toISOString() }
  }
  const hint = /コンテキスト|余力/.test(reason) ? 'コンテキストの余力は理由にできない。' : ''
  return { ok: false, message: `${hint}T-IDLE の受け入れの理由は「${answerWait}」か「枠 HH:MM」から選ぶ` }
}
