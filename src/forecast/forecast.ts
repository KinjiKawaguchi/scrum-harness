import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { ItemRelations } from '../ports/index.ts'
import type { StatusEvent } from '../sprint/effort.ts'
import { classify, tasksOf, type Excluded, type Task } from './model.ts'
import { areaLoads, conflictsOf, criticalPath, fewestWithin, staffing, usefulParallelism, type AreaLoad, type Chain, type Conflicts, type StaffingPoint, type Width } from './plan.ts'
import { finishedCandidates, measureVelocity, mergeRate, type MergeRate, type Velocity } from './velocity.ts'

export type ForecastInput = {
  readonly snapshot: Snapshot
  /** The labels and open blockers of the issues; null when the board source has none (then the graph has no edges and no areas, and is not used) */
  readonly relations: ReadonlyMap<string, ItemRelations> | null
  /** The Status changes of the finished issues; null when they could not be read */
  readonly events: ReadonlyMap<string, readonly StatusEvent[]> | null
  readonly config: Config
  readonly now: Date
  /** The number of members to plan with; the members of the configuration when not given */
  readonly people?: number
  /** The end of the day to finish by, as a time */
  readonly by?: Date
}

export type Answer =
  | { readonly kind: 'unknown'; readonly why: string }
  | {
      readonly kind: 'known'
      readonly people: number
      readonly finishHours: number
      /** The time to finish with the quickest and the slowest quarter of the measured speed */
      readonly range: { readonly fastHours: number; readonly slowHours: number } | null
    }

export type Reachable =
  | { readonly kind: 'yes'; readonly people: number }
  | { readonly kind: 'withMore'; readonly needed: number; readonly have: number }
  | { readonly kind: 'no'; readonly blockedBy: 'chain' | 'area' | 'members'; readonly detail: string }
  | { readonly kind: 'unknown'; readonly why: string }

export type Forecast = {
  readonly now: Date
  readonly velocity: Velocity
  readonly merges: MergeRate | null
  readonly work: readonly Task[]
  readonly schedulable: readonly Task[]
  readonly excluded: readonly Excluded[]
  readonly points: number
  /** Whether the graph is real: the dependencies and labels were read. When not, the numbers that need them are not given. */
  readonly hasGraph: boolean
  /** Issues whose labels and blockers could not be read */
  readonly unread: readonly string[]
  readonly critical: Chain | null
  readonly areas: readonly AreaLoad[]
  readonly conflicts: Conflicts
  readonly width: Width | null
  readonly curve: readonly StaffingPoint[]
  readonly stopsHelping: number | null
  readonly people: number
  readonly answer: Answer
  readonly by: { readonly date: Date; readonly hoursLeft: number; readonly reachable: Reachable } | null
}

const HOUR_MS = 3_600_000

/** How many members the plan uses when none is given: the members of the configuration. */
export const defaultPeople = (config: Config): number => Math.max(1, config.members.length)

function reachableBy(forecast: Pick<Forecast, 'curve' | 'critical' | 'areas' | 'people' | 'schedulable' | 'width'>, hoursLeft: number, speed: number): Reachable {
  const limit = hoursLeft * speed
  const have = forecast.curve.find((point) => point.people === forecast.people)?.time ?? forecast.curve.at(-1)?.time ?? 0
  if (have <= limit + 1e-9) return { kind: 'yes', people: forecast.people }
  const needed = fewestWithin(forecast.curve, limit)
  if (needed !== null) return { kind: 'withMore', needed, have: forecast.people }
  const chain = forecast.critical?.points ?? 0
  const area = forecast.areas[0]
  const hours = (points: number): string => `${(points / speed).toFixed(1)} hours`
  if (chain > limit) return { kind: 'no', blockedBy: 'chain', detail: `the longest chain of dependencies (${forecast.critical?.refs.join(' > ')}) takes ${hours(chain)}, and ${hours(limit)} are left` }
  if (area !== undefined && area.points > limit) return { kind: 'no', blockedBy: 'area', detail: `the issues of area ${area.area} do not run at once and take ${hours(area.points)} between them, and ${hours(limit)} are left` }
  const best = forecast.curve.at(-1)?.time ?? 0
  return { kind: 'no', blockedBy: 'members', detail: `even with ${forecast.curve.at(-1)?.people ?? forecast.people} members, as many as can run at once, it takes ${hours(best)}, and ${hours(limit)} are left` }
}

/** Everything `scrum forecast` says, worked out from the board copy, the issues' relations, and the Status changes of the finished issues. Pure. */
export function forecast(input: ForecastInput): Forecast {
  const { snapshot, config, now } = input
  const velocity = measureVelocity(finishedCandidates(snapshot, config, now), input.events, config, now)
  const work = tasksOf(snapshot, input.relations ?? new Map(), config)
  const hasGraph = input.relations !== null
  const { schedulable, excluded } = classify(work)
  const points = schedulable.reduce((sum, task) => sum + (task.points ?? 0), 0)
  const people = Math.max(1, Math.floor(input.people ?? defaultPeople(config)))
  const unread = hasGraph ? work.filter((task) => !(input.relations?.has(task.ref) ?? false)).map((task) => task.ref).toSorted() : []
  const width = hasGraph && schedulable.length > 0 ? usefulParallelism(schedulable) : null
  const plan = hasGraph && width !== null ? staffing(schedulable, width.size, people) : { curve: [] as readonly StaffingPoint[], stopsHelping: null }
  const critical = hasGraph ? criticalPath(schedulable) : null
  const areas = hasGraph ? areaLoads(schedulable) : []
  const speed = velocity.kind === 'measured' ? velocity.pointsPerHour : null
  const timeAt = plan.curve.find((point) => point.people === people)?.time ?? plan.curve.at(-1)?.time ?? 0
  const answer: Answer =
    !hasGraph
      ? { kind: 'unknown', why: 'this board source does not give the issues\' dependencies and labels, so the graph, and with it the time to finish, is not worked out' }
      : speed === null
        ? { kind: 'unknown', why: velocity.kind === 'missing' ? `no velocity (${velocity.why}), so the work is given in points and not in hours` : 'no velocity' }
        : {
            kind: 'known',
            people,
            finishHours: timeAt / speed,
            range: velocity.kind === 'measured' && velocity.high > 0 && velocity.low > 0 ? { fastHours: timeAt / velocity.high, slowHours: timeAt / velocity.low } : null,
          }
  const base = { curve: plan.curve, critical, areas, people, schedulable, width }
  const by =
    input.by === undefined
      ? null
      : {
          date: input.by,
          hoursLeft: Math.max(0, (input.by.getTime() - now.getTime()) / HOUR_MS),
          reachable: (!hasGraph || speed === null ? { kind: 'unknown', why: answer.kind === 'unknown' ? answer.why : 'no velocity' } : reachableBy(base, Math.max(0, (input.by.getTime() - now.getTime()) / HOUR_MS), speed)) as Reachable,
        }
  return { now, velocity, merges: mergeRate(snapshot, now), work, schedulable, excluded, points, hasGraph, unread, critical, areas, conflicts: hasGraph ? conflictsOf(schedulable) : { ordered: [], shared: [] }, width, curve: plan.curve, stopsHelping: plan.stopsHelping, people, answer, by }
}
