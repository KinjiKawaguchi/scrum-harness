import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { assessItem, type Assessment } from './assess.ts'
import { localClock, nextCheckpoint } from './checkpoints.ts'
import type { Completion } from './completion.ts'
import type { CountingHistory } from './counting-history.ts'
import { doingIssues } from './record.ts'

const cell = (value: number | null): string => (value === null ? '-' : String(value))
const overCell = (over: number | null): string => (over === null ? '-' : over > 0 ? `+${over}` : '0')
/** 手間。全セッションが止まっていて除いた節目があれば、その数を添える。 */
const effortCell = (assessment: Assessment): string =>
  assessment.teamStopped === undefined ? cell(assessment.effort) : `${cell(assessment.effort)} (除いた節目 ${assessment.teamStopped})`

/** 済んだ issue を、新しい順に並べて出す件数。 */
const RECENT_COMPLETIONS = 20

const medianOf = (values: readonly number[]): string => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * 同じ issue の記録が複数あれば (作業中から完了、戻して作業中、また完了)、新しいものだけを使う。かかった節目は、
 * Status の変化の記録を通しで数えるので、新しい記録が、前の分も含んでいる。
 */
function latestPerIssue(completions: readonly Completion[]): readonly Completion[] {
  const oldestFirst = completions.toSorted((a, b) => a.detectedAt.localeCompare(b.detectedAt))
  return [...new Map(oldestFirst.map((one) => [one.label, one])).values()]
}

/** 済んだ issue の、ポイント・目安・かかった節目を 1 件ずつ並べ、ポイントごとに件数・中央値・幅・目安を超えた件数を出す。 */
export function formatCompletions(all: readonly Completion[]): readonly string[] {
  const completions = latestPerIssue(all)
  if (completions.length === 0) return []
  const recent = completions.toSorted((a, b) => b.detectedAt.localeCompare(a.detectedAt)).slice(0, RECENT_COMPLETIONS)
  const items = recent.map((one) => [one.label, cell(one.points), cell(one.budget), cell(one.effort), one.exact ? '' : '近似'].join('\t'))
  const measured = completions.filter((one) => one.points !== null && one.effort !== null)
  const tiers = [...new Set(measured.map((one) => one.points ?? 0))].toSorted((a, b) => a - b)
  const perTier = tiers.map((points) => {
    const group = measured.filter((one) => one.points === points)
    const efforts = group.map((one) => one.effort ?? 0)
    const budget = group[0]?.budget ?? null
    const over = group.filter((one) => one.budget !== null && (one.effort ?? 0) > one.budget).length
    return [points, cell(budget), group.length, medianOf(efforts), `${Math.min(...efforts)}〜${Math.max(...efforts)}`, over].join('\t')
  })
  return [
    '',
    `済んだ issue の予実 (新しい順に最大 ${RECENT_COMPLETIONS} 件。かかった節目は、止まっていた節目を除く。近似は、Status の変化を読めず、前の控えで数えたもの)`,
    'issue\tポイント\t目安\tかかった節目\t備考',
    ...items,
    '',
    'ポイントごとの予実 (かかった節目の中央値と幅)',
    'ポイント\t目安\t件数\t中央値\t幅\t目安を超えた件数',
    ...perTier,
  ]
}

/** `scrum points` の表。作業中の issue を、超えた数の多い順に並べる。済んだ issue の予実が記録にあれば、その下に出す。 */
export function formatPoints(
  snapshot: Snapshot,
  history: CountingHistory,
  config: Config,
  now: Date,
  completions: readonly Completion[] = [],
): string {
  const sprint = config.sprint
  if (sprint === undefined) return 'sprint の設定が無い (config.json の sprint)'
  const rows = doingIssues(snapshot, config)
    .map((item) => ({ item, assessment: assessItem(item, history, config, now) }))
    .toSorted((a, b) => (b.assessment.over ?? -1) - (a.assessment.over ?? -1) || a.assessment.label.localeCompare(b.assessment.label))
    .map(({ item, assessment }) =>
      [
        assessment.label,
        cell(assessment.points),
        cell(assessment.budget),
        effortCell(assessment),
        overCell(assessment.over),
        item.reason ?? '-',
        item.assignee ?? '-',
      ].join('\t'),
    )
  return [
    'issue\tポイント\t目安\t手間\t超過\t止まっている理由\t担当',
    ...rows,
    `次の節目: ${localClock(nextCheckpoint(now, sprint).getTime(), sprint)} (手間は作業中にまたいだ節目の数。止まっていた節目と、全セッションが止まっていた節目は除く)`,
    ...formatCompletions(completions),
  ].join('\n')
}
