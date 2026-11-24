import { readText, type Paths } from '../store.ts'
import type { Interval } from './effort.ts'

/** 動きの記録がこれだけ途切れたら、その間は全セッションが止まっていたとみなす (2 時間)。 */
export const TEAM_STOP_MS = 2 * 60 * 60 * 1000

/**
 * チームの誰かが動いたことを示す記録の種類。member-state、stop-blocked、woke、acked は watch が書き、activity は、
 * チームのセッションのフック (bin/scrum) が、watch が動いていなくても 10 分に 1 回書く。
 * launchd が誰も動いていなくても書く指摘の開閉 (finding-opened、finding-closed) は、動きに数えない。
 */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set(['member-state', 'stop-blocked', 'woke', 'acked', 'activity'])

/** その時刻に、全セッションが止まっていたか。 */
export type TeamStop = (at: Date) => boolean

export const NEVER_STOPPED: TeamStop = () => false

function activityTime(line: string): readonly number[] {
  try {
    const record = JSON.parse(line) as { readonly at?: unknown; readonly type?: unknown }
    if (typeof record.type !== 'string' || !ACTIVITY_TYPES.has(record.type) || typeof record.at !== 'string') return []
    const at = Date.parse(record.at)
    return Number.isNaN(at) ? [] : [at]
  } catch {
    return []
  }
}

/** events.jsonl の本文から、動きの記録の時刻 (ミリ秒) を古い順に返す。読めない行と、動きでない種類は捨てる。 */
export function activityTimes(text: string): readonly number[] {
  return text
    .split('\n')
    .flatMap(activityTime)
    .toSorted((a, b) => a - b)
}

/**
 * 動きの記録が minimum 以上途切れた期間。最後の動きから今までも、minimum 以上なら含める。
 * 動きの記録が 1 件も無ければ、何も言えないので空を返す。
 */
export function stoppedSpans(times: readonly number[], now: Date, minimum: number = TEAM_STOP_MS): readonly Interval[] {
  const edges = [...times, now.getTime()]
  return edges.slice(1).flatMap((end, index): readonly Interval[] => {
    const start = edges[index] ?? end
    return end - start >= minimum ? [{ start, end }] : []
  })
}

/** 止まっていた期間のどれかの内側 (両端は含まない) にある時刻を、止まっていたとみなす。 */
export function teamStopFrom(spans: readonly Interval[]): TeamStop {
  return (at) => spans.some((span) => span.start < at.getTime() && at.getTime() < span.end)
}

/** ~/.claude/scrum/log/events.jsonl から、全セッションが止まっていた期間を作る。 */
export function loadTeamStop(p: Paths, now: Date): TeamStop {
  return teamStopFrom(stoppedSpans(activityTimes(readText(p.events)), now))
}
