import { label } from '../board/rules.ts'
import type { Config } from '../config.ts'
import { makeFinding } from '../findings/types.ts'
import { alertsOf } from './config.ts'
import { stalledViews, type EpicView } from './epic.ts'
import { minutesSince, ownerNotice, shortTitle } from './text.ts'
import type { AlertEvaluation } from './types.ts'

function doingDetail(view: EpicView): string {
  if (view.doing.length === 0) return 'no children In Progress'
  const shown = view.doing.slice(0, 3).map((child) => `${label(child)} assignee ${child.assignee ?? 'none'} reason ${child.reason ?? '-'}`)
  return `children In Progress: ${shown.join(', ')}${view.doing.length > 3 ? ` and ${view.doing.length - 3} more` : ''}`
}

/** まとめた通知の 1 行に書く、動く人がいない理由。オーナーの答え待ちだけ、作業中の子の理由、作業中の子なし (子の状態の数)、のどれか。 */
function stallReason(view: EpicView, config: Config): string {
  const waiting = ownerWaitLabels(view, config)
  if (waiting.length > 0) return `waiting for ${config.ownerLabel}'s answer (${waiting.join(', ')})`
  if (view.doing.length > 0) return `In Progress children are blocked (${view.doing.length}): ${[...new Set(view.doing.map((child) => child.reason ?? '-'))].join(', ')}`
  const count = (status: string) => view.openChildren.filter((child) => child.status === status).length
  return `no children In Progress (${config.statuses.next} ${count(config.statuses.next)}, ${config.statuses.backlog} ${count(config.statuses.backlog)})`
}

/** 作業中の子がすべて、オーナーの判断待ちなら、その子の一覧。そうでなければ (作業中の子が無いときも) 空。 */
function ownerWaitLabels(view: EpicView, config: Config): readonly string[] {
  return view.doing.every((child) => child.reason === config.reasonJudge) ? view.doing.map(label) : []
}

/** 「app#100「題」」の形。題が無いときは、続く助詞との間に空白を置く。 */
function titled(view: EpicView): string {
  return view.title === null ? view.epic : `${view.epic} "${shortTitle(view.title)}"`
}

/**
 * 動いている人がいない状態が epicStallMinutes 続いた Epic。TechLead に指摘 (E-STALL、重さ高) を出し、
 * オーナーにも伝える通知を作る。最初に見た時刻は state が持つ (まだ見ていない Epic は出さない)。
 */
export function evaluateEpicStalls(
  views: readonly EpicView[],
  since: Readonly<Record<string, string>>,
  config: Config,
  now: Date,
): AlertEvaluation {
  const limits = alertsOf(config)
  const limit = limits.epicStallMinutes
  const items = stalledViews(views).flatMap((view) => {
    const first = since[view.epic]
    return first === undefined || minutesSince(first, now) < limit ? [] : [{ view, first, minutes: minutesSince(first, now) }]
  })
  return {
    findings: items.map(({ view, first, minutes }) => {
      const waiting = ownerWaitLabels(view, config)
      return makeFinding({
        rule: 'E-STALL',
        subject: view.epic,
        keySuffix: first,
        severity: 'high',
        minutes,
        message: `Nobody has been moving Epic ${titled(view)} for ${minutes} minutes (open children: ${view.openChildren.length}. ${doingDetail(view)})`,
        fix:
          waiting.length > 0
            ? `Blocked only on ${config.ownerLabel}'s answer. ${config.ownerLabel} is told with the pending question attached (liaison PushNotification)`
            : 'Get the assignee moving (SendMessage). If no child is In Progress, hand a child from Next to someone',
      })
    }),
    owner: items.map(({ view, first, minutes }) =>
      ownerNotice({
        key: `E-STALL:${view.epic}:${first}`,
        head: `E-STALL ${view.epic}`,
        push: `Nobody has been moving Epic ${titled(view)} for ${minutes} minutes.`,
        waitingLabels: ownerWaitLabels(view, config),
        line: `nobody is moving ${titled(view)} for ${minutes} minutes (${stallReason(view, config)})`,
        throttle: { key: `epic:${view.epic}`, minutes: limits.epicPushMinutes },
        config,
      }),
    ),
  }
}
