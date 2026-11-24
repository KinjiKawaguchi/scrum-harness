import { label } from '../board/rules.ts'
import type { Config } from '../config.ts'
import { makeFinding } from '../findings/types.ts'
import { alertsOf } from './config.ts'
import { stalledViews, type EpicView } from './epic.ts'
import { minutesSince, ownerNotice, shortTitle } from './text.ts'
import type { AlertEvaluation } from './types.ts'

function doingDetail(view: EpicView): string {
  if (view.doing.length === 0) return '作業中の子なし'
  const shown = view.doing.slice(0, 3).map((child) => `${label(child)} 担当 ${child.assignee ?? 'なし'} 理由 ${child.reason ?? '-'}`)
  return `作業中の子: ${shown.join('、')}${view.doing.length > 3 ? ` ほか ${view.doing.length - 3} 件` : ''}`
}

/** まとめた通知の 1 行に書く、動く人がいない理由。オーナーの答え待ちだけ、作業中の子の理由、作業中の子なし (子の状態の数)、のどれか。 */
function stallReason(view: EpicView, config: Config): string {
  const waiting = ownerWaitLabels(view, config)
  if (waiting.length > 0) return `${config.ownerLabel}の答え待ち (${waiting.join('、')})`
  if (view.doing.length > 0) return `作業中の子 ${view.doing.length} 件が、${[...new Set(view.doing.map((child) => child.reason ?? '-'))].join('、')} で止まっている`
  const count = (status: string) => view.openChildren.filter((child) => child.status === status).length
  return `作業中の子なし (${config.statuses.next} ${count(config.statuses.next)} 件、${config.statuses.backlog} ${count(config.statuses.backlog)} 件)`
}

/** 作業中の子がすべて、オーナーの判断待ちなら、その子の一覧。そうでなければ (作業中の子が無いときも) 空。 */
function ownerWaitLabels(view: EpicView, config: Config): readonly string[] {
  return view.doing.every((child) => child.reason === config.reasonJudge) ? view.doing.map(label) : []
}

/** 「app#100「題」」の形。題が無いときは、続く助詞との間に空白を置く。 */
function titled(view: EpicView): string {
  return view.title === null ? `${view.epic} ` : `${view.epic}「${shortTitle(view.title)}」`
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
        message: `Epic ${titled(view)}を動かしている人がいない状態が ${minutes} 分続いている (開いた子 ${view.openChildren.length} 件。${doingDetail(view)})`,
        fix:
          waiting.length > 0
            ? `${config.ownerLabel}の答え待ちだけで止まっている。待っている問いを添えて、${config.ownerLabel}に伝わる (窓口の PushNotification)`
            : '担当を動かす (SendMessage)。作業中の子が無ければ、次にやるの子を誰かに渡す',
      })
    }),
    owner: items.map(({ view, first, minutes }) =>
      ownerNotice({
        key: `E-STALL:${view.epic}:${first}`,
        head: `E-STALL ${view.epic}`,
        push: `Epic ${titled(view)}を動かしている人がいない状態が ${minutes} 分続いています。`,
        waitingLabels: ownerWaitLabels(view, config),
        line: `${titled(view)}を動かす人がいない ${minutes} 分 (${stallReason(view, config)})`,
        throttle: { key: `epic:${view.epic}`, minutes: limits.epicPushMinutes },
        config,
      }),
    ),
  }
}
