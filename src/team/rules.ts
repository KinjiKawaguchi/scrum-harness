import { label } from '../board/rules.ts'
import { SCRUM_CLI } from '../cli-path.ts'
import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { makeFinding, type Finding } from '../findings/types.ts'
import type { MemberState } from './types.ts'

function minutesSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 60_000)
}

function openIssues(snapshot: Snapshot, config: Config, status: string) {
  return snapshot.items.filter(
    (item) =>
      item.kind === 'issue' &&
      item.state === 'OPEN' &&
      item.status === status &&
      !config.excludeAuthors.includes(item.author ?? ''),
  )
}

function idleFinding(member: MemberState, minutes: number, snapshot: Snapshot, config: Config): Finding {
  const doing = openIssues(snapshot, config, config.statuses.doing).filter((item) => item.tanto === member.name)
  const next = openIssues(snapshot, config, config.statuses.next)
  const doingText = doing.length > 0 ? doing.map((item) => `${label(item)} (${item.reason ?? '理由なし'})`).join(' ') : 'なし'
  const nextText = next.length > 0 ? next.map(label).join(' ') : 'なし'
  return makeFinding({
    rule: 'T-IDLE',
    subject: member.name,
    keySuffix: member.since ?? '',
    severity: 'high',
    minutes,
    message: `${member.name} が ${minutes} 分空いている。担当の作業中: ${doingText}。次にやる: ${nextText}`,
    fix: `仕事を振る (SendMessage) か、意図した待ちなら ${SCRUM_CLI} ack T-IDLE ${member.name} --for 1h --reason "${config.ownerLabel}の答え待ち" (理由は「${config.ownerLabel}の答え待ち」か「枠 HH:MM」、最長 1 時間。dispatch が有効なら、受け入れが無い空きにはハーネスが次の仕事を渡す)`,
  })
}

function waitingFinding(member: MemberState, minutes: number, config: Config): Finding {
  return makeFinding({
    rule: 'T-WAITING',
    subject: member.name,
    keySuffix: member.since ?? '',
    severity: 'high',
    minutes,
    message: `${member.name} が ${minutes} 分、許可の確認で止まっている`,
    fix: `${config.ownerLabel} に知らせる (PushNotification)。TechLead から許可を代わりに出させない`,
  })
}

function untrackedFinding(member: MemberState, minutes: number, config: Config): Finding {
  return makeFinding({
    rule: 'T-BUSY-UNTRACKED',
    subject: member.name,
    severity: 'low',
    message: `${member.name} は ${minutes} 分動いているが、担当の作業中の issue がボードに無い`,
    fix:
      config.scripts.setTanto === undefined
        ? `今の作業の issue の担当を ${member.name} にする`
        : `今の作業の issue に ${config.scripts.setTanto} <番号> ${member.name}`,
  })
}

function lintMember(member: MemberState, snapshot: Snapshot, config: Config, now: Date): readonly Finding[] {
  if (member.since === null) return []
  const minutes = minutesSince(member.since, now)
  if (member.state === 'idle' && minutes >= config.idleMinutes) {
    return [idleFinding(member, minutes, snapshot, config)]
  }
  if (member.state === 'waiting' && minutes >= config.waitingMinutes) return [waitingFinding(member, minutes, config)]
  if (member.state !== 'busy' || minutes < config.untrackedMinutes) return []
  const hasDoing = openIssues(snapshot, config, config.statuses.doing).some((item) => item.tanto === member.name)
  return hasDoing ? [] : [untrackedFinding(member, minutes, config)]
}

export function lintTeam(
  members: readonly MemberState[],
  snapshot: Snapshot,
  config: Config,
  now: Date,
): readonly Finding[] {
  return members.flatMap((member) => lintMember(member, snapshot, config, now))
}
