import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { assessItem, type Assessment } from './assess.ts'
import { localClock, nextCheckpoint } from './checkpoints.ts'
import type { Completion } from './completion.ts'
import type { CountingHistory } from './counting-history.ts'
import { doingIssues } from './record.ts'

const cell = (value: number | null): string => (value === null ? '-' : String(value))
const overCell = (over: number | null): string => (over === null ? '-' : over > 0 ? `+${over}` : '0')
/** Effort. If there are checkpoints excluded because all sessions were stalled, adds that number. */
const effortCell = (assessment: Assessment): string =>
  assessment.teamStopped === undefined ? cell(assessment.effort) : `${cell(assessment.effort)} (excluded checkpoints ${assessment.teamStopped})`

/** The number of finished issues shown, lined up newest first. */
const RECENT_COMPLETIONS = 20

const medianOf = (values: readonly number[]): string => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * If there are several records for the same issue (In Progress to Done, sent back to In Progress, Done again), only the latest is used. The checkpoints it took are
 * counted across the whole Status change record, so the latest record includes the earlier part.
 */
function latestPerIssue(completions: readonly Completion[]): readonly Completion[] {
  const oldestFirst = completions.toSorted((a, b) => a.detectedAt.localeCompare(b.detectedAt))
  return [...new Map(oldestFirst.map((one) => [one.label, one])).values()]
}

/** Lines up, one by one, the points, budget, and checkpoints taken for finished issues, and shows, per point value, the count, median, range, and the count that exceeded the budget. */
export function formatCompletions(all: readonly Completion[]): readonly string[] {
  const completions = latestPerIssue(all)
  if (completions.length === 0) return []
  const recent = completions.toSorted((a, b) => b.detectedAt.localeCompare(a.detectedAt)).slice(0, RECENT_COMPLETIONS)
  const items = recent.map((one) => [one.label, cell(one.points), cell(one.budget), cell(one.effort), one.exact ? '' : 'approx.'].join('\t'))
  const measured = completions.filter((one) => one.points !== null && one.effort !== null)
  const tiers = [...new Set(measured.map((one) => one.points ?? 0))].toSorted((a, b) => a - b)
  const perTier = tiers.map((points) => {
    const group = measured.filter((one) => one.points === points)
    const efforts = group.map((one) => one.effort ?? 0)
    const budget = group[0]?.budget ?? null
    const over = group.filter((one) => one.budget !== null && (one.effort ?? 0) > one.budget).length
    return [points, cell(budget), group.length, medianOf(efforts), `${Math.min(...efforts)}-${Math.max(...efforts)}`, over].join('\t')
  })
  return [
    '',
    `Estimate versus actual of finished issues (up to ${RECENT_COMPLETIONS}, newest first. Checkpoints taken exclude the stopped ones. "approx." means the Status changes could not be read and the previous board copy was used)`,
    'issue\tpoints\tbudget\tcheckpoints taken\tnote',
    ...items,
    '',
    'Estimate versus actual by points (median and range of checkpoints taken)',
    'points\tbudget\tcount\tmedian\trange\tover budget',
    ...perTier,
  ]
}

/** The table of `scrum points`. Lines up In Progress issues in descending order of exceeded number. If the record has estimate-versus-actual for finished issues, shows it below. */
export function formatPoints(
  snapshot: Snapshot,
  history: CountingHistory,
  config: Config,
  now: Date,
  completions: readonly Completion[] = [],
): string {
  const sprint = config.sprint
  if (sprint === undefined) return 'There is no sprint configuration (sprint in config.json)'
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
    'issue\tpoints\tbudget\teffort\toverrun\tblocked reason\tassignee',
    ...rows,
    `Next checkpoint: ${localClock(nextCheckpoint(now, sprint).getTime(), sprint)} (effort is the number of checkpoints crossed while In Progress. Checkpoints with a block and checkpoints where all sessions were stopped are excluded)`,
    ...formatCompletions(completions),
  ].join('\n')
}
