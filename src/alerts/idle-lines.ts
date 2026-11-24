import { dispatchOf } from '../config.ts'
import type { Ack } from '../findings/acks.ts'
import type { DispatchRecord } from '../dispatch/types.ts'
import type { MemberState } from '../team/types.ts'
import { isRecordedEmpty } from './empty.ts'
import type { AlertInput } from './rules.ts'
import { clock, minutesSince } from './text.ts'
import type { Notice } from './types.ts'

function ackText(acks: readonly Ack[], name: string, now: Date, offset: string): string {
  const ack = acks.find((one) => one.rule === 'T-IDLE' && one.subject === name && Date.parse(one.until) > now.getTime())
  return ack === undefined ? 'none' : `${ack.reason} (until ${clock(ack.until, offset)})`
}

/** 今の空きの間に、ハーネスがその人に送った最後の仕事 (渡した、促した)。 */
function lastSend(records: readonly DispatchRecord[], member: MemberState): DispatchRecord | undefined {
  const since = Date.parse(member.since ?? '')
  return records.filter((record) => record.member === member.name && Date.parse(record.at) >= since).at(-1)
}

function actionText(input: AlertInput, member: MemberState, offset: string): string {
  const sent = lastSend(input.dispatches, member)
  if (sent !== undefined) return `${sent.kind === 'nudge' ? 'nudged' : 'handed over'} ${sent.label} (${clock(sent.at, offset)})`
  return isRecordedEmpty(input.alerts.empty, member.name) ? 'no issue to hand over' : 'nothing sent yet'
}

/**
 * 部下が idleMinutes 空いたとき (T-IDLE と同じ時点) の、窓口への 1 行。受け入れがあっても出す。
 * オーナーへの通知ではなく、窓口が空きを知っておくための行。
 */
export function idleLines(input: AlertInput): readonly Notice[] {
  const { members, acks, config, now } = input
  const offset = dispatchOf(config).utcOffset
  return members
    .filter((member) => config.members.includes(member.name) && member.state === 'idle' && member.since !== null)
    .flatMap((member) => {
      const minutes = minutesSince(member.since ?? '', now)
      if (minutes < config.idleMinutes) return []
      const text = `${member.name} has been idle for ${minutes} minutes. Acknowledgement: ${ackText(acks, member.name, now, offset)}. Harness action: ${actionText(input, member, offset)}`
      return [{ key: `idle-line:${member.name}:${member.since}`, kind: 'idle-line' as const, text: `- ${text}` }]
    })
}
