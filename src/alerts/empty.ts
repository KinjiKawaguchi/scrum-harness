import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { decideAction } from '../dispatch/decide.ts'
import { idleGate } from '../dispatch/due.ts'
import type { DispatchRecord } from '../dispatch/types.ts'
import type { Ack } from '../findings/acks.ts'
import type { MemberState } from '../team/types.ts'

/** wip-limit は作業中が上限に達している、no-candidate は渡せる issue が無い。 */
export type EmptyReason = 'wip-limit' | 'no-candidate'

export type EmptyChoice = { readonly member: MemberState; readonly reason: EmptyReason }

/**
 * 空いて、受け入れも無く、渡す相手に入っているのに、渡せる issue が無い部下。
 * 渡し済み、促し中 (自分の作業中がある) は、渡せるものが無いのではないので入れない。
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

/** 最初に見た時刻の記録の鍵。理由ごとに数える (作業中が上限で空いていた人が、渡せる issue が無いに変わったら、その時から数え直す)。 */
export function emptyKey(name: string, reason: EmptyReason): string {
  return `${name}:${reason}`
}

/** 部下が、いずれかの理由で記録に入っているか。 */
export function isRecordedEmpty(since: Readonly<Record<string, string>>, name: string): boolean {
  return Object.keys(since).some((key) => key.startsWith(`${name}:`))
}

/** いま渡せるものが無い部下だけを残し、最初に見た時刻は、同じ理由が続いていれば前のものを引き継ぐ。理由が変われば、その時から数え直す。 */
export function advanceEmpty(prev: Readonly<Record<string, string>>, choices: readonly EmptyChoice[], now: Date): Readonly<Record<string, string>> {
  return Object.fromEntries(choices.map(({ member, reason }) => [emptyKey(member.name, reason), prev[emptyKey(member.name, reason)] ?? now.toISOString()]))
}
