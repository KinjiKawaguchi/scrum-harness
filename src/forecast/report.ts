import type { Forecast } from './forecast.ts'
import type { Excluded, Task } from './model.ts'

const HOUR_MS = 3_600_000

const pad = (value: number): string => String(value).padStart(2, '0')

/** A time as `YYYY-MM-DD HH:MM` in the zone `offsetMinutes` east of UTC. */
export function clock(ms: number, offsetMinutes: number): string {
  const at = new Date(ms + offsetMinutes * 60_000)
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`
}

/** Hours as `3.5 hours`, and over a day as `1.4 days (34 hours)`. */
export function hoursText(hours: number): string {
  if (hours >= 48) return `${(hours / 24).toFixed(1)} days (${Math.round(hours)} hours)`
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hours`
}

const points = (list: readonly Task[]): number => list.reduce((sum, task) => sum + (task.points ?? 0), 0)
const refs = (list: readonly string[], limit = 12): string => (list.length <= limit ? list.join(' ') : `${list.slice(0, limit).join(' ')} and ${list.length - limit} more`)
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

function excludedLines(excluded: readonly Excluded[]): readonly string[] {
  const of = <K extends Excluded['kind']>(kind: K) => excluded.filter((one): one is Extract<Excluded, { kind: K }> => one.kind === kind)
  const waiting = of('waiting')
  const person = waiting.filter((one) => one.who === 'person')
  const outside = waiting.filter((one) => one.who === 'outside')
  const total = (list: readonly { readonly task: Task }[]): string => {
    const known = list.filter((one) => one.task.points !== null)
    return `${plural(list.length, 'issue')}${known.length === 0 ? '' : `, ${points(known.map((one) => one.task))} points`}`
  }
  return [
    ...(person.length === 0 ? [] : [`  waiting for the owner (a decision): ${total(person)}: ${refs(person.map((one) => one.task.ref))}`]),
    ...(outside.length === 0 ? [] : [`  waiting for an outside event, time, or equipment: ${total(outside)}: ${refs(outside.map((one) => one.task.ref))}`]),
    ...(of('behindWait').length === 0 ? [] : [`  blocked by one that waits (it cannot start before): ${total(of('behindWait'))}: ${refs(of('behindWait').map((one) => `${one.task.ref} (after ${one.via})`))}`]),
    ...(of('unestimated').length === 0 ? [] : [`  without points (unestimated, so not in any number): ${plural(of('unestimated').length, 'issue')}: ${refs(of('unestimated').map((one) => one.task.ref))}`]),
    ...(of('behindUnestimated').length === 0 ? [] : [`  blocked by an unestimated issue (its start is not known): ${total(of('behindUnestimated'))}: ${refs(of('behindUnestimated').map((one) => `${one.task.ref} (after ${one.via})`))}`]),
    ...(of('cycle').length === 0 ? [] : [`  in or behind a cycle of dependencies (it never starts): ${refs(of('cycle').map((one) => one.task.ref))}; the cycle: ${refs([...new Set(of('cycle').flatMap((one) => one.members))])}`]),
  ]
}

/** The report for people. `offsetMinutes` is the time zone the times are written in. */
export function formatForecast(f: Forecast, offsetMinutes: number): string {
  const speed = f.velocity.kind === 'measured' ? f.velocity.pointsPerHour : null
  const timeOf = (pointTime: number): string => (speed === null ? `${pointTime} points` : `${hoursText(pointTime / speed)} (${pointTime} points)`)
  const lines: string[] = [`Forecast as of ${clock(f.now.getTime(), offsetMinutes)} (UTC${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)})`, '']

  lines.push('Velocity (the last 7 days)')
  if (f.velocity.kind === 'measured') {
    const v = f.velocity
    lines.push(`  ${v.pointsPerHour.toFixed(2)} points per member-hour (the slowest quarter ${v.low.toFixed(2)}, the fastest ${v.high.toFixed(2)}): ${plural(v.samples, 'issue')}, ${v.points} points, ${hoursText(v.hours)} In Progress`)
    if (v.skipped.length > 0) lines.push(`  not used: ${refs(v.skipped, 6)}`)
  } else lines.push(`  not measured: ${f.velocity.why}`)
  lines.push(f.merges === null ? '  merge rate: not read (the board has no pull requests with their times)' : `  merge rate: ${plural(f.merges.merged, 'pull request')} merged, ${f.merges.perDay.toFixed(1)} per day (${f.merges.perHour.toFixed(2)} per hour)`)
  lines.push('')

  lines.push('The work (open issues that are not epics, in Backlog, Next, or In Progress)')
  lines.push(`  ${plural(f.work.length, 'issue')}; ${plural(f.schedulable.length, 'issue')} (${f.points} points) are in the plan`)
  lines.push(...excludedLines(f.excluded))
  if (f.unread.length > 0) lines.push(`  not read (their labels and dependencies are unknown, so they count as having none): ${refs(f.unread)}`)
  lines.push('')

  if (!f.hasGraph) {
    lines.push('Graph: not worked out. This board source does not give the issues\' dependencies (`blocked_by`) and `area:` labels, so the critical path, the parallelism, and the staffing would be guesses.')
    return lines.join('\n')
  }

  lines.push('The graph')
  const edges = f.schedulable.reduce((sum, task) => sum + task.blockedBy.length, 0)
  lines.push(`  ${edges} ${edges === 1 ? 'dependency' : 'dependencies'} between issues in the plan (an issue waits for what blocks it), ${plural(f.conflicts.shared.length, 'pair')} that name the same area and so do not run at once`)
  if (f.conflicts.shared.length > 0) lines.push(`  areas in conflict: ${[...new Set(f.conflicts.shared.map(([, , area]) => area))].join(', ')}`)
  lines.push('')

  if (f.critical === null) {
    lines.push('Nothing is in the plan: there is no critical path.')
    return lines.join('\n')
  }
  lines.push(`Critical path: ${f.critical.refs.join(' > ')}`)
  lines.push(`  ${timeOf(f.critical.points)}: no staffing finishes the plan sooner than this chain`)
  const area = f.areas[0]
  if (area !== undefined) lines.push(`Busiest area: ${area.area}, ${timeOf(area.points)} of issues that run one after another (${refs(area.refs, 8)})`)
  const bound = Math.max(f.critical.points, area?.points ?? 0)
  lines.push(`  shortest possible, whatever the staffing: ${timeOf(bound)}`)
  lines.push('')

  if (f.width !== null) {
    lines.push(`Useful parallelism: ${f.width.isExact ? '' : 'at least '}${plural(f.width.size, 'issue')} can run at once (no two depend on each other or share an area): ${refs(f.width.refs, 12)}`)
    lines.push('  more members than that add nothing')
    lines.push('')
  }

  lines.push('Staffing (members: time to finish the plan)')
  for (const point of f.curve) lines.push(`  ${String(point.people).padStart(2)}${point.people === f.people ? ' *' : '  '} ${timeOf(point.time)}${speed === null ? '' : `, ${clock(f.now.getTime() + (point.time / speed) * HOUR_MS, offsetMinutes)}`}`)
  lines.push(`  (* the members now: ${f.people}.) ${f.stopsHelping === null ? '' : `Another member stops helping after ${f.stopsHelping}.`}`)
  lines.push('')

  lines.push('Answer')
  if (f.answer.kind === 'known') {
    lines.push(`  With ${plural(f.answer.people, 'member')}, the plan is done in ${hoursText(f.answer.finishHours)}, about ${clock(f.now.getTime() + f.answer.finishHours * HOUR_MS, offsetMinutes)}${f.answer.range === null || f.answer.range.fastHours === f.answer.range.slowHours ? '' : ` (between ${hoursText(f.answer.range.fastHours)} and ${hoursText(f.answer.range.slowHours)} at the fastest and the slowest quarter of the measured speed)`}.`)
    lines.push('  Work in progress is counted at its full points, as how far it is is not known; the hours are hours In Progress, which pass at night too.')
  } else lines.push(`  ${f.answer.why}.`)
  if (f.by !== null) {
    const when = clock(f.by.date.getTime(), offsetMinutes)
    const r = f.by.reachable
    lines.push(`  By ${when} (${hoursText(f.by.hoursLeft)} from now): ${r.kind === 'yes' ? `reachable with ${plural(r.people, 'member')}.` : r.kind === 'withMore' ? `reachable with ${plural(r.needed, 'member')}, not with the ${r.have} now: what blocks it is the number of members.` : r.kind === 'no' ? `not reachable. What blocks it is ${r.blockedBy === 'chain' ? 'the critical path' : r.blockedBy === 'area' ? 'an area' : 'the members'}: ${r.detail}.` : `cannot be said: ${r.why}.`}`)
  }
  const waiting = f.excluded.filter((one) => one.kind === 'waiting' || one.kind === 'behindWait')
  if (waiting.length > 0) lines.push(`  Not in these times: ${plural(waiting.length, 'issue')} that wait for the owner or an outside event, or for one that does; no staffing moves them.`)
  const unknown = f.excluded.filter((one) => one.kind === 'unestimated' || one.kind === 'behindUnestimated')
  if (unknown.length > 0) lines.push(`  Not in these times either: ${plural(unknown.length, 'unestimated issue')} and what waits for them; the real finish is later.`)
  return lines.join('\n')
}

/** The same as an object, for `--json`. */
export function forecastJson(f: Forecast): unknown {
  return {
    asOf: f.now.toISOString(),
    velocity: f.velocity,
    mergeRate: f.merges,
    work: { issues: f.work.length, inPlan: f.schedulable.length, points: f.points, excluded: f.excluded.map((one) => ({ kind: one.kind, ref: one.task.ref })) },
    graph: f.hasGraph ? { unread: f.unread, orderedPairs: f.conflicts.ordered.length, sharedAreaPairs: f.conflicts.shared.map(([a, b, area]) => ({ a, b, area })) } : null,
    criticalPath: f.critical,
    areas: f.areas,
    width: f.width,
    staffing: { people: f.people, stopsHelping: f.stopsHelping, curve: f.curve },
    answer: f.answer,
    by: f.by === null ? null : { date: f.by.date.toISOString(), hoursLeft: f.by.hoursLeft, reachable: f.by.reachable },
  }
}
