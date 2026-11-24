import type { Config } from '../config.ts'
import { makeFinding } from '../findings/types.ts'
import { alertsOf } from './config.ts'
import { emptyKey, type EmptyChoice, type EmptyReason } from './empty.ts'
import { minutesSince, ownerNotice } from './text.ts'
import type { AlertEvaluation } from './types.ts'

function reasonText(reason: EmptyReason, member: string, config: Config): string {
  return reason === 'wip-limit'
    ? `In Progress is at the limit of ${config.wipLimit}`
    : `no issue to hand over in Next (unassigned or ${member}) or in Backlog (assigned to ${member})`
}

/**
 * A member who is free with no issue to hand over. The TechLead gets a finding (Q-EMPTY, high severity) from the moment it is found.
 * If it is still not fixed after emptyEscalateMinutes with the handable work exhausted (no-candidate), a finding that also reaches the owner (Q-EMPTY-OWNER, high severity) and a notification are added
 * (at most once per emptyPushMinutes for the same person). When In Progress is at its limit (wip-limit) and nothing can be handed over, the work to hand over has not run out, so only the TechLead is told.
 * The time first seen is held by state (a person not yet seen is not raised). It is counted per reason, so if a person who was free because In Progress was at its limit becomes no issue to hand over, the 30 minutes are counted from that moment.
 */
export function evaluateEmpty(
  choices: readonly EmptyChoice[],
  since: Readonly<Record<string, string>>,
  config: Config,
  now: Date,
): AlertEvaluation {
  const limits = alertsOf(config)
  const limit = limits.emptyEscalateMinutes
  const items = choices.flatMap(({ member, reason }) => {
    const first = since[emptyKey(member.name, reason)]
    return first === undefined ? [] : [{ name: member.name, first, reason, minutes: minutesSince(first, now), why: reasonText(reason, member.name, config) }]
  })
  const escalated = items.filter((item) => item.minutes >= limit && item.reason === 'no-candidate')
  return {
    findings: [
      ...items.map(({ name, first, minutes, why, reason }) =>
        makeFinding({
          rule: 'Q-EMPTY',
          subject: name,
          keySuffix: first,
          severity: 'high',
          minutes,
          message: `${name} is idle but there is no issue to hand over (${why}). It has lasted ${minutes} minutes`,
          fix:
            reason === 'wip-limit'
              ? `Nothing can be handed over because In Progress is at the limit. Review the blocked In Progress items (set a reason, or move them back to Backlog). Shown to the TechLead only (not to ${config.ownerLabel})`
              : `Line up issues in Next, or in the Backlog assigned to ${name} (set the assignee and the order). If none are lined up in ${limit} minutes, ${config.ownerLabel} is told too`,
        }),
      ),
      ...escalated.map(({ name, first, minutes, why }) =>
        makeFinding({
          rule: 'Q-EMPTY-OWNER',
          subject: name,
          keySuffix: first,
          severity: 'high',
          minutes,
          message: `${minutes} minutes have passed with no issue to hand over to ${name} (${why}). Tell ${config.ownerLabel}`,
          fix: `${config.techlead} lines up issues. Once they do, this finding goes away`,
        }),
      ),
    ],
    owner: escalated.map(({ name, first, minutes, why }) =>
      ownerNotice({
        key: `Q-EMPTY-OWNER:${name}:${first}`,
        head: `Q-EMPTY ${name}`,
        push: `${minutes} minutes have passed with no issue to hand over to ${name} (${why}). Waiting for ${config.techlead} to line them up.`,
        waitingLabels: [],
        line: `no issue to hand over to ${name} for ${minutes} minutes (${why})`,
        throttle: { key: `empty:${name}`, minutes: limits.emptyPushMinutes },
        config,
      }),
    ),
  }
}
