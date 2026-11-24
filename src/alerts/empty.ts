import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { decideAction } from '../dispatch/decide.ts'
import { idleGate } from '../dispatch/due.ts'
import type { DispatchRecord } from '../dispatch/types.ts'
import type { Ack } from '../findings/acks.ts'
import type { MemberState } from '../team/types.ts'

/** wip-limit means In Progress has reached its limit, and no-candidate means there is no issue to hand over. */
export type EmptyReason = 'wip-limit' | 'no-candidate'

export type EmptyChoice = { readonly member: MemberState; readonly reason: EmptyReason }

/**
 * A member who is free, has no acknowledgement, is among those who receive handovers, and yet has no issue to hand over.
 * One already handed over to, or being nudged (has their own In Progress), is not included, because it is not that there is nothing to hand over.
 */
export function emptyChoices(
  snapshot: Snapshot,
  members: readonly MemberState[],
  acks: readonly Ack[],
  records: readonly DispatchRecord[],
  config: Config,
  now: Date,
): readonly EmptyChoice[] {
  return members
    .filter((member) => idleGate(member, acks, config, now).isDue)
    .flatMap((member) => {
      const action = decideAction(snapshot, member, records, config, now)
      return action.kind === 'none' && (action.reason === 'wip-limit' || action.reason === 'no-candidate') ? [{ member, reason: action.reason }] : []
    })
}

/** The key of the record of the time first seen. It is counted per reason (if a person free because In Progress was at its limit becomes no issue to hand over, counting restarts from that moment). */
export function emptyKey(name: string, reason: EmptyReason): string {
  return `${name}:${reason}`
}

/** Whether a member is in the record for any reason. */
export function isRecordedEmpty(since: Readonly<Record<string, string>>, name: string): boolean {
  return Object.keys(since).some((key) => key.startsWith(`${name}:`))
}

/** Keeps only members who have nothing to hand over right now. The time first seen is carried over from the earlier one if the same reason continues. If the reason changes, counting restarts from that moment. */
export function advanceEmpty(prev: Readonly<Record<string, string>>, choices: readonly EmptyChoice[], now: Date): Readonly<Record<string, string>> {
  return Object.fromEntries(choices.map(({ member, reason }) => [emptyKey(member.name, reason), prev[emptyKey(member.name, reason)] ?? now.toISOString()]))
}
