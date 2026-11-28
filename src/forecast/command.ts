import { workStatusOf } from '../agency-runtime/work.ts'
import { isEpic } from '../board/rules.ts'
import { loadSnapshot } from '../board/snapshot.ts'
import type { Flags } from '../cli-commands.ts'
import { type Config } from '../config.ts'
import { usageOffsetMinutes } from '../agency-runtime/config.ts'
import type { Ports } from '../ports/index.ts'
import { describeError, type Paths } from '../store.ts'
import { forecast } from './forecast.ts'
import { finishedCandidates } from './velocity.ts'
import { formatForecast, forecastJson } from './report.ts'

const message = (error: unknown): string => describeError(error).slice(0, 300)

/** `--by 2026-12-05`: the end of that day in the time zone, as a time; null when it is not a date. */
export function endOfDay(text: string, offsetMinutes: number): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return null
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59) - offsetMinutes * 60_000
  return Number.isNaN(at) || new Date(at).getUTCDate() !== Number(match[3]) ? null : new Date(at)
}

/**
 * `scrum forecast [--by <date>] [--people <n>] [--json]`: when the ready work finishes and how many people it can use, from the board copy, the issues'
 * dependencies and `area:` labels (read from the tracker now), and how fast the finished issues of the last 7 days went. It writes nothing.
 */
export function forecastCommand(p: Paths, config: Config, ports: Ports, flags: Flags, now: Date = new Date()): string {
  const offsetMinutes = usageOffsetMinutes(config)
  const by = typeof flags.by === 'string' ? endOfDay(flags.by, offsetMinutes) : undefined
  if (by === null) return '--by must be a date such as 2026-12-05'
  const people = typeof flags.people === 'string' ? Number(flags.people) : undefined
  if (people !== undefined && !(Number.isInteger(people) && people >= 1 && people <= 100)) return '--people must be a whole number from 1 to 100'
  const snapshot = loadSnapshot(p)
  if (snapshot === null) return 'The board has not been read yet: run `scrum refresh` first.'
  const notes: string[] = []
  // only the issues the plan is made of: open, in Backlog, Next, or In Progress, and not an epic
  const open = snapshot.items.filter((item) => item.kind === 'issue' && item.state === 'OPEN' && ['backlog', 'next', 'inProgress'].includes(workStatusOf(item, config) ?? '') && !isEpic(item, snapshot.items))
  let relations: ReturnType<NonNullable<Ports['board']['relations']>> | null = null
  if (ports.board.relations !== undefined) {
    try {
      relations = ports.board.relations(open)
    } catch (error) {
      notes.push(`The dependencies and labels could not be read now (${message(error)}), so the graph is not worked out.`)
    }
  }
  let events: ReturnType<Ports['board']['statusEvents']> = null
  try {
    events = ports.board.statusEvents(finishedCandidates(snapshot, config, now))
  } catch (error) {
    notes.push(`The Status changes of the finished issues could not be read (${message(error)}), so the velocity is not measured.`)
  }
  const result = forecast({ snapshot, relations, events, config, now, ...(people === undefined ? {} : { people }), ...(by === undefined ? {} : { by }) })
  if (flags.json === true) return JSON.stringify(forecastJson(result), null, 1)
  if (config.sprint === undefined && config.fields.points === undefined) notes.push('The points are not read: name the board\'s number field in `fields.points` (or give a `sprint` section), or every issue is unestimated.')
  const age = Math.round((now.getTime() - Date.parse(snapshot.fetchedAt)) / 60_000)
  return [formatForecast(result, offsetMinutes), '', `From the board copy read ${age} minutes ago.`, ...notes].join('\n')
}
