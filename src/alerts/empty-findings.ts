import type { Config } from '../config.ts'
import { makeFinding } from '../findings/types.ts'
import { alertsOf } from './config.ts'
import { emptyKey, type EmptyChoice, type EmptyReason } from './empty.ts'
import { minutesSince, ownerNotice } from './text.ts'
import type { AlertEvaluation } from './types.ts'

function reasonText(reason: EmptyReason, member: string, config: Config): string {
  return reason === 'wip-limit'
    ? `作業中が上限 ${config.wipLimit} 件に達している`
    : `次にやる (担当なし か ${member}) と、バックログ (担当 ${member}) に、渡せる issue が無い`
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
          message: `${name} が空いているのに、渡せる issue が無い (${why})。${minutes} 分続いている`,
          fix:
            reason === 'wip-limit'
              ? `作業中が上限で渡せない。止まっている作業中を見直す (理由を付ける、バックログに戻す)。TechLead だけに出る (${config.ownerLabel}には出ない)`
              : `次にやる か、${name} 担当のバックログに issue を並べる (担当と順を付ける)。${limit} 分並ばなければ、${config.ownerLabel}にも伝わる`,
        }),
      ),
      ...escalated.map(({ name, first, minutes, why }) =>
        makeFinding({
          rule: 'Q-EMPTY-OWNER',
          subject: name,
          keySuffix: first,
          severity: 'high',
          minutes,
          message: `${name} に渡せる issue が無いまま ${minutes} 分たった (${why})。${config.ownerLabel}に伝える`,
          fix: `${config.techlead} が issue を並べる。並べれば、この指摘は消える`,
        }),
      ),
    ],
    owner: escalated.map(({ name, first, minutes, why }) =>
      ownerNotice({
        key: `Q-EMPTY-OWNER:${name}:${first}`,
        head: `Q-EMPTY ${name}`,
        push: `${name} に渡せる issue が無いまま ${minutes} 分たちました (${why})。${config.techlead} が並べるのを待っています。`,
        waitingLabels: [],
        line: `${name} に渡せる issue が無い ${minutes} 分 (${why})`,
        throttle: { key: `empty:${name}`, minutes: limits.emptyPushMinutes },
        config,
      }),
    ),
  }
}
