import { dispatchOf, type Config } from '../config.ts'
import type { Ack } from '../findings/acks.ts'
import type { MemberState } from '../team/types.ts'
import { isValidIdleAck, SLOT_LEAD_MS } from './idle-ack.ts'
import type { DispatchRecord } from './types.ts'

export type DueResult =
  | { readonly isDue: true }
  | { readonly isDue: false; readonly reason: 'disabled' | 'not-target' | 'not-idle' | 'too-short' | 'already-dispatched' | 'accepted' }

export type IdleGateResult = Exclude<DueResult, { readonly reason: 'already-dispatched' }>

/** 自動で渡すのを止める受け入れ。検査を通る形のものだけ。枠の受け入れは、枠の始まりの 15 分前から。 */
function isBlockingAck(ack: Ack, member: string, config: Config, now: Date): boolean {
  if (ack.rule !== 'T-IDLE' || ack.subject !== member || Date.parse(ack.until) <= now.getTime() || !isValidIdleAck(ack, config)) return false
  return ack.slotAt === undefined || now.getTime() >= Date.parse(ack.slotAt) - SLOT_LEAD_MS
}

/** 新しい issue を渡した最後の時刻 (促しは数えない)。無ければ 0。 */
function lastDispatchAt(records: readonly DispatchRecord[], member: string): number {
  return Math.max(0, ...records.filter((record) => record.member === member && record.kind !== 'nudge').map((record) => Date.parse(record.at)))
}

/**
 * 部下に何かを送る時か (新しい issue を渡すか、自分の作業中を進めるよう促すかは、別に決める)。
 * 空きが idleMinutes 続き、有効な受け入れが無く、渡す相手に入っていること。
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
 * 部下に次の issue を渡す時か。idleGate に加えて、前に渡した後、その人が一度も動かないまま
 * (空きが渡した時刻より前から続いている) なら、重ねて渡さない。
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
