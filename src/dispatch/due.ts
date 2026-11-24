import { dispatchOf, type Config } from '../config.ts'
import type { Ack } from '../findings/acks.ts'
import type { MemberState } from '../team/types.ts'
import { isValidIdleAck, SLOT_LEAD_MS } from './idle-ack.ts'
import type { DispatchRecord } from './types.ts'

export type DueResult =
  | { readonly isDue: true }
  | { readonly isDue: false; readonly reason: 'disabled' | 'not-target' | 'not-idle' | 'too-short' | 'already-dispatched' | 'accepted' }

export type IdleGateResult = Exclude<DueResult, { readonly reason: 'already-dispatched' }>

/** An acknowledgement that stops automatic hand-over. Only those of a shape that passes the check. A slot acknowledgement applies from 15 minutes before the slot starts. */
function isBlockingAck(ack: Ack, member: string, config: Config, now: Date): boolean {
  if (ack.rule !== 'T-IDLE' || ack.subject !== member || Date.parse(ack.until) <= now.getTime() || !isValidIdleAck(ack, config)) return false
  return ack.slotAt === undefined || now.getTime() >= Date.parse(ack.slotAt) - SLOT_LEAD_MS
}

/** The last time a new issue was handed over (nudges are not counted). 0 if none. */
function lastDispatchAt(records: readonly DispatchRecord[], member: string): number {
  return Math.max(0, ...records.filter((record) => record.member === member && record.kind !== 'nudge').map((record) => Date.parse(record.at)))
}

/**
 * Whether it is time to send something to a member (whether to hand over a new issue or nudge them to advance their own In Progress issue is decided separately).
 * The free span has lasted idleMinutes, there is no valid acknowledgement, and the member is among those who receive handovers.
 */
export function idleGate(member: MemberState, acks: readonly Ack[], config: Config, now: Date): IdleGateResult {
  const dispatch = dispatchOf(config)
  if (!dispatch.enabled) return { isDue: false, reason: 'disabled' }
  if (!(dispatch.members ?? config.members).includes(member.name)) return { isDue: false, reason: 'not-target' }
  if (member.state !== 'idle' || member.since === null) return { isDue: false, reason: 'not-idle' }
  if ((now.getTime() - Date.parse(member.since)) / 60_000 < config.idleMinutes) return { isDue: false, reason: 'too-short' }
  if (acks.some((ack) => isBlockingAck(ack, member.name, config, now))) return { isDue: false, reason: 'accepted' }
  return { isDue: true }
}

/**
 * Whether it is time to hand the next issue to a member. In addition to idleGate, if after the previous handover the person has not moved even once
 * (the free span has continued since before the handover time), it is not handed over again.
 */
export function dispatchDue(
  member: MemberState,
  acks: readonly Ack[],
  records: readonly DispatchRecord[],
  config: Config,
  now: Date,
): DueResult {
  const gate = idleGate(member, acks, config, now)
  if (!gate.isDue) return gate
  if (member.since !== null && lastDispatchAt(records, member.name) >= Date.parse(member.since)) return { isDue: false, reason: 'already-dispatched' }
  return { isDue: true }
}
