import type { ParticipantDay, ParticipantMetrics } from '../agency-runtime/types.ts'

/** Whole hours and minutes, as `2h05`; under an hour, `45m`; nothing, `-`. */
export function duration(seconds: number): string {
  if (seconds <= 0) return '-'
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

const compact = (count: number): string => (count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1000 ? `${Math.round(count / 1000)}k` : String(count))

const cell = (text: string, width: number): string => text.padStart(width)
const total = (days: readonly ParticipantDay[], pick: (day: ParticipantDay) => number): number => days.reduce((sum, day) => sum + pick(day), 0)

function zoneOf(offsetMinutes: number): string {
  const abs = Math.abs(offsetMinutes)
  return `UTC${offsetMinutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

function table(name: string, days: readonly ParticipantDay[]): string {
  const line = (date: string, busy: number, waiting: number, idle: number, cost: number, tail: string): string =>
    `  ${date.padEnd(10)}  ${cell(duration(busy), 6)} ${cell(duration(waiting), 6)} ${cell(duration(idle), 6)}  ${cell(`$${cost.toFixed(2)}`, 8)}  ${tail}`
  const rows = days.map((day) => line(day.date, day.busySeconds, day.waitingSeconds, day.idleSeconds, day.costUsd, `${cell(compact(day.tokens.input + day.tokens.output), 7)} in+out ${cell(compact(day.tokens.cacheRead), 7)} cache`))
  const sums = line('total', total(days, (d) => d.busySeconds), total(days, (d) => d.waitingSeconds), total(days, (d) => d.idleSeconds), total(days, (d) => d.costUsd), '')
  return [name, `  ${'date'.padEnd(10)}  ${cell('busy', 6)} ${cell('wait', 6)} ${cell('idle', 6)}  ${cell('cost', 8)}`, ...rows, sums.trimEnd()].join('\n')
}

/** The report for people: a table of days for each participant, then the pull requests whose author the hooks saw. */
export function formatParticipantMetrics(report: ParticipantMetrics): string {
  const header = `${report.team}: the last ${report.days} days (${zoneOf(report.utcOffsetMinutes)}), at ${report.generatedAt}`
  const participants = report.participants.length === 0 ? ['No participant has time, cost, or tokens in this range.'] : report.participants.flatMap((one) => [table(one.name, one.byDay), ''])
  const authors = report.pullRequests.length === 0 ? ['No pull request has a known author yet.'] : ['Pull requests with a known author:', ...report.pullRequests.map((pr) => `  ${pr.repo}#${pr.number}  ${pr.by}`)]
  const note = 'Time counts only while a session of the participant was alive; overlapping sessions count once, busy before waiting before idle. A pull request is listed only when the hooks saw its session open it.'
  return [header, '', ...participants, ...authors, '', note].join('\n')
}
