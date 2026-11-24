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
  const doing = openIssues(snapshot, config, config.statuses.doing).filter((item) => item.assignee === member.name)
  const next = openIssues(snapshot, config, config.statuses.next)
  const doingText = doing.length > 0 ? doing.map((item) => `${label(item)} (${item.reason ?? 'no reason'})`).join(' ') : 'none'
  const nextText = next.length > 0 ? next.map(label).join(' ') : 'none'
  return makeFinding({
    rule: 'T-IDLE',
    subject: member.name,
    keySuffix: member.since ?? '',
    severity: 'high',
    minutes,
    message: `${member.name} has been idle for ${minutes} minutes. Their In Progress: ${doingText}. Next: ${nextText}`,
    fix: `Assign work (SendMessage), or for an intended wait run ${SCRUM_CLI} ack T-IDLE ${member.name} --for 1h --reason "Waiting for ${config.ownerLabel}'s answer" (the reason is "Waiting for ${config.ownerLabel}'s answer" or "slot HH:MM", for at most 1 hour. With dispatch enabled, the harness hands the next work to an idle member who has no acknowledgement)`,
  })
}

function waitingFinding(member: MemberState, minutes: number, config: Config): Finding {
  return makeFinding({
    rule: 'T-WAITING',
    subject: member.name,
    keySuffix: member.since ?? '',
    severity: 'high',
    minutes,
    message: `${member.name} has been stopped at a permission prompt for ${minutes} minutes`,
    fix: `Tell ${config.ownerLabel} (PushNotification). Do not approve on their behalf from the TechLead`,
  })
}

function untrackedFinding(member: MemberState, minutes: number, config: Config): Finding {
  return makeFinding({
    rule: 'T-BUSY-UNTRACKED',
    subject: member.name,
    severity: 'low',
    message: `${member.name} has been active for ${minutes} minutes, but no In Progress issue on the board is assigned to them`,
    fix:
      config.scripts.setAssignee === undefined
        ? `Assign the issue they are working on to ${member.name}`
        : `Run ${config.scripts.setAssignee} <number> ${member.name} on the issue they are working on`,
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
  const hasDoing = openIssues(snapshot, config, config.statuses.doing).some((item) => item.assignee === member.name)
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
