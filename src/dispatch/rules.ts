import { label } from '../board/rules.ts'
import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { makeFinding, type Finding } from '../findings/types.ts'
import type { MemberState } from '../team/types.ts'
import { ignoredNudges, NUDGE_LIMIT, NUDGE_WINDOW_MS } from './decide.ts'
import { boardToken, seenKey, type SeenMap } from './progress.ts'
import type { DispatchRecord } from './types.ts'

/** 渡したことを TechLead に伝える間 (分)。この間は、まだ伝えていなければ中の指摘として出る。 */
const REPORT_MINUTES = 120

/** 促しを、その人とその issue ごとに、直近 NUDGE_WINDOW_MS の中で集める (古い順)。 */
function nudgesByIssue(records: readonly DispatchRecord[], member: string, now: Date): ReadonlyMap<string, readonly DispatchRecord[]> {
  const nudges = records
    .filter((record) => record.kind === 'nudge' && record.member === member && now.getTime() - Date.parse(record.at) <= NUDGE_WINDOW_MS)
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return nudges.reduce((acc, record) => new Map([...acc, [record.label, [...(acc.get(record.label) ?? []), record]]]), new Map<string, readonly DispatchRecord[]>())
}

/**
 * 作業が進まないまま促しを NUDGE_LIMIT 回続けて送り、いまも空きの部下。TechLead に出す (A-NUDGE-IGNORED、重さ中)。
 * 短い 1 つのターンで空きに戻っても、空きの区間が変わっても、続けて数える。作業が進んだかは、促した時点の印と、いまの印で比べる。
 * いまの印は、ボードの印を今のボードから、コードの置き場の印を、待機プロセスが最後に見た分 (seen) から取り、促しの判断と同じ印で比べる。
 * 指紋は、続いた促しの最初の時刻ごと (続く間は 1 回だけ出る)。
 */
function lintIgnoredNudges(records: readonly DispatchRecord[], members: readonly MemberState[], now: Date, snapshot: Snapshot | null, seen: SeenMap): readonly Finding[] {
  return members.flatMap((member) => {
    if (member.state !== 'idle' || member.since === null) return []
    const minutes = Math.floor((now.getTime() - Date.parse(member.since)) / 60_000)
    return [...nudgesByIssue(records, member.name, now)].flatMap(([issue, nudges]) => {
      const item = snapshot?.items.find((one) => label(one) === issue)
      const streak = ignoredNudges(nudges, item === undefined ? undefined : { board: boardToken(item), github: seen[seenKey(member.name, issue)]?.token.github ?? null })
      const first = nudges.at(-streak)
      if (streak < NUDGE_LIMIT || first === undefined) return []
      return [
        makeFinding({
          rule: 'A-NUDGE-IGNORED',
          subject: member.name,
          keySuffix: `${issue}:${first.at}`,
          severity: 'medium',
          message: `${member.name} に、作業中の ${issue} を進めるよう ${streak} 回促したが、その間に作業 (ボードの変化、PR や紐づいたブランチの動き) が無いまま、空きに戻っている (いまの空きは ${minutes} 分)`,
          fix: `作業中が本当に待ちなら、止まっている理由を付けさせる (付くと次の仕事が渡る)。そうでなければ、${member.name} に直接伝える`,
        }),
      ]
    })
  })
}

/**
 * 渡した仕事の記録から、「誰に何を渡したか」の指摘 (A-DISPATCHED、重さ中) と、促しが進まない部下の指摘を作る。
 * 渡したのは機械で、直す必要は無い。
 */
export function lintDispatch(
  records: readonly DispatchRecord[],
  config: Config,
  now: Date,
  members: readonly MemberState[] = [],
  snapshot: Snapshot | null = null,
  seen: SeenMap = {},
): readonly Finding[] {
  return [...lintDispatched(records, config, now), ...lintIgnoredNudges(records, members, now, snapshot, seen)]
}

function lintDispatched(records: readonly DispatchRecord[], config: Config, now: Date): readonly Finding[] {
  return records
    .filter((record) => record.kind !== 'nudge' && (now.getTime() - Date.parse(record.at)) / 60_000 <= REPORT_MINUTES)
    .map((record) =>
      makeFinding({
        rule: 'A-DISPATCHED',
        subject: record.label,
        keySuffix: record.at,
        severity: 'medium',
        message: `${record.member} が空いていたので、${record.label} ${record.title} を自動で渡した (Status は ${config.statuses.doing}、担当は ${record.member})`,
        fix: `渡し方が合わないときは、担当と Status を直して ${record.member} に伝える。何もしなければ、そのまま進む`,
      }),
    )
}
