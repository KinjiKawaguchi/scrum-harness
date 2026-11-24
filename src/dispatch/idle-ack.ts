import type { Config } from '../config.ts'
import { dispatchOf } from '../config.ts'
import type { Ack } from '../findings/acks.ts'

/** The longest T-IDLE acknowledgement. It does not silence for longer than this. */
export const IDLE_ACK_MAX_MS = 60 * 60_000

/** A "slot" acknowledgement does not stop automatic hand-over until this long before the slot starts. */
export const SLOT_LEAD_MS = 15 * 60_000

const SLOT = /^slot ([01]\d|2[0-3]):([0-5]\d)$/

export type IdleAckCheck = { readonly ok: true; readonly slotAt: string | null } | { readonly ok: false; readonly message: string }

export function offsetMinutes(offset: string): number {
  const sign = offset.startsWith('-') ? -1 : 1
  const [hours = '0', minutes = '0'] = offset.slice(1).split(':')
  return sign * (Number(hours) * 60 + Number(minutes))
}

/** The instant of that time on the same day as now (the date on the offset's side). */
function clockOnSameDay(now: Date, hour: number, minute: number, offset: string): number {
  const shift = offsetMinutes(offset) * 60_000
  const local = new Date(now.getTime() + shift)
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - shift
}

/**
 * The instant a slot starts. If today's time was more than 1 hour ago, it is regarded as a finished slot and tomorrow's time is used.
 * If it was within the past hour, the present is inside the slot, so today's time is kept.
 */
export function slotInstant(now: Date, hour: number, minute: number, offset: string): Date {
  const today = clockOnSameDay(now, hour, minute, offset)
  return new Date(today < now.getTime() - IDLE_ACK_MAX_MS ? today + 86_400_000 : today)
}

/**
 * Whether a stored T-IDLE acknowledgement is of a shape that passes the check at creation (checkIdleAck). At most 1 hour (deadline - creation time), and the reason is exactly
 * "waiting for <owner>'s answer" or "slot HH:MM" with the slot's start. An acknowledgement not created through the check (a long deadline, a reason such as spare capacity,
 * or text after the reason) does not pass, and stops neither automatic hand-over nor the T-IDLE finding. Acknowledgements other than T-IDLE are not looked at.
 */
export function isValidIdleAck(ack: Ack, config: Config): boolean {
  if (ack.rule !== 'T-IDLE') return true
  const length = Date.parse(ack.until) - Date.parse(ack.at)
  if (!(length <= IDLE_ACK_MAX_MS)) return false
  if (ack.reason === `Waiting for ${config.ownerLabel}'s answer`) return true
  return SLOT.test(ack.reason) && ack.slotAt !== undefined
}

/**
 * Checks a T-IDLE acknowledgement. The reason is chosen from fixed phrases (waiting for the owner's answer, slot HH:MM).
 * Spare context capacity cannot be a reason. The length is at most 1 hour.
 */
export function checkIdleAck(input: { readonly reason: string; readonly durationMs: number; readonly now: Date; readonly config: Config }): IdleAckCheck {
  const { reason, durationMs, now, config } = input
  const answerWait = `Waiting for ${config.ownerLabel}'s answer`
  if (durationMs > IDLE_ACK_MAX_MS) return { ok: false, message: 'A T-IDLE acknowledgement lasts at most 1 hour (up to --for 1h)' }
  if (reason === answerWait) return { ok: true, slotAt: null }
  const slot = SLOT.exec(reason)
  if (slot !== null) {
    const at = slotInstant(now, Number(slot[1]), Number(slot[2]), dispatchOf(config).utcOffset)
    const lead = at.getTime() - now.getTime()
    if (lead > IDLE_ACK_MAX_MS + SLOT_LEAD_MS) return { ok: false, message: 'A slot must start within 1 hour 15 minutes (automatic hand-over stops 15 minutes before the slot)' }
    return { ok: true, slotAt: at.toISOString() }
  }
  const hint = /context|capacity/i.test(reason) ? 'Spare context capacity cannot be a reason. ' : ''
  return { ok: false, message: `${hint}The reason of a T-IDLE acknowledgement must be "${answerWait}" or "slot HH:MM"` }
}
