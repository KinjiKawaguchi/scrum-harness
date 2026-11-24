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
 * 渡せる issue が無いまま空いている部下。TechLead には見つけた時から指摘 (Q-EMPTY、重さ高) を出す。
 * 渡せるものが尽きた (no-candidate) まま emptyEscalateMinutes たっても直らなければ、オーナーにも伝わる指摘 (Q-EMPTY-OWNER、重さ高) と通知を足す
 * (同じ人は emptyPushMinutes に 1 回まで)。作業中が上限 (wip-limit) で渡せないときは、渡すものが尽きたのではないので、TechLead だけに出す。
 * 最初に見た時刻は state が持つ (まだ見ていない人は出さない)。理由ごとに数えるので、作業中が上限で空いていた人が、渡せる issue が無いに変わったら、その時から 30 分を数える。
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
