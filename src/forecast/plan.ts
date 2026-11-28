import type { Task } from './model.ts'

/**
 * The plan's numbers are in points of work for one member: a member does one point in one unit of time, so a time here is points, and the caller turns it
 * into hours with the velocity it measured. Only tasks that can be scheduled (estimated, not waiting, not behind one that is) are given.
 */

/** The tasks in an order where every blocker comes before what it blocks (the tasks must have no cycle). */
function inOrder(tasks: readonly Task[]): readonly Task[] {
  const byRef = new Map(tasks.map((task) => [task.ref, task]))
  const done = new Set<string>()
  const order: Task[] = []
  const visit = (task: Task): void => {
    if (done.has(task.ref)) return
    done.add(task.ref)
    for (const ref of task.blockedBy) {
      const blocker = byRef.get(ref)
      if (blocker !== undefined) visit(blocker)
    }
    order.push(task)
  }
  for (const task of tasks.toSorted((a, b) => a.ref.localeCompare(b.ref))) visit(task)
  return order
}

const pointsOf = (task: Task): number => task.points ?? 0

export type Chain = { readonly refs: readonly string[]; readonly points: number }

/** The longest chain of dependencies by points: what no staffing can make shorter. Null with no tasks. */
export function criticalPath(tasks: readonly Task[]): Chain | null {
  if (tasks.length === 0) return null
  const longest = new Map<string, { readonly points: number; readonly from: string | null }>()
  for (const task of inOrder(tasks)) {
    const best = task.blockedBy.flatMap((ref) => (longest.has(ref) ? [{ ref, points: longest.get(ref)?.points ?? 0 }] : [])).toSorted((a, b) => b.points - a.points || a.ref.localeCompare(b.ref))[0]
    longest.set(task.ref, { points: pointsOf(task) + (best?.points ?? 0), from: best?.ref ?? null })
  }
  const end = [...longest].toSorted(([a, x], [b, y]) => y.points - x.points || a.localeCompare(b))[0]
  if (end === undefined) return null
  const refs: string[] = []
  for (let ref: string | null = end[0]; ref !== null; ref = longest.get(ref)?.from ?? null) refs.unshift(ref)
  return { refs, points: end[1].points }
}

export type AreaLoad = { readonly area: string; readonly points: number; readonly refs: readonly string[] }

/** The points in each area. Two issues of one area do not run at once, so an area's points are a lower bound on the time of its issues, whatever the staffing. Biggest first. */
export function areaLoads(tasks: readonly Task[]): readonly AreaLoad[] {
  const areas = new Map<string, Task[]>()
  for (const task of tasks) for (const area of task.areas) areas.set(area, [...(areas.get(area) ?? []), task])
  return [...areas].map(([area, list]) => ({ area, points: list.reduce((sum, task) => sum + pointsOf(task), 0), refs: list.map((task) => task.ref).toSorted() })).toSorted((a, b) => b.points - a.points || a.area.localeCompare(b.area))
}

/** For each task, the tasks it must wait for, directly or through others. */
function ancestors(tasks: readonly Task[]): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>()
  for (const task of inOrder(tasks)) {
    const set = new Set<string>()
    for (const ref of task.blockedBy) {
      if (!result.has(ref)) continue
      set.add(ref)
      for (const up of result.get(ref) ?? []) set.add(up)
    }
    result.set(task.ref, set)
  }
  return result
}

export type Conflicts = {
  /** Pairs where one waits for the other, directly or through others */
  readonly ordered: readonly (readonly [string, string])[]
  /** Pairs that name the same area (and are not ordered), with the area */
  readonly shared: readonly (readonly [string, string, string])[]
}

const pairs = <T>(list: readonly T[]): readonly (readonly [T, T])[] => list.flatMap((a, i) => list.slice(i + 1).map((b) => [a, b] as const))

/** What keeps two issues from running at once. */
export function conflictsOf(tasks: readonly Task[]): Conflicts {
  const above = ancestors(tasks)
  const isOrdered = (a: Task, b: Task): boolean => above.get(a.ref)?.has(b.ref) === true || above.get(b.ref)?.has(a.ref) === true
  const all = pairs(tasks.toSorted((a, b) => a.ref.localeCompare(b.ref)))
  return {
    ordered: all.filter(([a, b]) => isOrdered(a, b)).map(([a, b]) => [a.ref, b.ref] as const),
    shared: all.flatMap(([a, b]) => {
      const area = a.areas.find((one) => b.areas.includes(one))
      return area === undefined || isOrdered(a, b) ? [] : [[a.ref, b.ref, area] as const]
    }),
  }
}

export type Width = { readonly size: number; readonly refs: readonly string[]; /** False when the search was cut short, so the size is at least this */ readonly isExact: boolean }

/** The most search steps spent on the widest set before the answer is said to be "at least". */
const SEARCH_LIMIT = 400_000

const popcount = (mask: bigint): number => {
  let count = 0
  for (let rest = mask; rest > 0n; rest >>= 1n) if ((rest & 1n) === 1n) count += 1
  return count
}

/**
 * The widest set of issues that can run at once: no two of them in a dependency, and no two in one area. It is the largest independent set of the conflict graph,
 * found by branching with a bound; on a board too big to finish it, the best set found, said to be "at least".
 */
export function usefulParallelism(tasks: readonly Task[]): Width {
  const sorted = tasks.toSorted((a, b) => a.ref.localeCompare(b.ref))
  const index = new Map(sorted.map((task, i) => [task.ref, i]))
  const conflicts = conflictsOf(sorted)
  const adjacency = sorted.map(() => 0n)
  for (const [a, b] of [...conflicts.ordered, ...conflicts.shared.map(([x, y]) => [x, y] as const)]) {
    const i = index.get(a) as number
    const j = index.get(b) as number
    adjacency[i] = (adjacency[i] ?? 0n) | (1n << BigInt(j))
    adjacency[j] = (adjacency[j] ?? 0n) | (1n << BigInt(i))
  }
  let best: readonly number[] = []
  let steps = 0
  let isExact = true
  const search = (candidates: bigint, chosen: readonly number[]): void => {
    if (steps >= SEARCH_LIMIT) {
      isExact = false
      return
    }
    steps += 1
    if (candidates === 0n) {
      if (chosen.length > best.length) best = chosen
      return
    }
    if (chosen.length + popcount(candidates) <= best.length) return
    let pick = -1
    let degree = -1
    for (let i = 0; i < sorted.length; i += 1) {
      if (((candidates >> BigInt(i)) & 1n) === 0n) continue
      const here = popcount((adjacency[i] ?? 0n) & candidates)
      if (here > degree) {
        degree = here
        pick = i
      }
    }
    if (degree === 0) {
      const rest = sorted.flatMap((_, i) => (((candidates >> BigInt(i)) & 1n) === 1n ? [i] : []))
      if (chosen.length + rest.length > best.length) best = [...chosen, ...rest]
      return
    }
    const bit = 1n << BigInt(pick)
    search(candidates & ~bit & ~(adjacency[pick] ?? 0n), [...chosen, pick])
    search(candidates & ~bit, chosen)
  }
  search((1n << BigInt(sorted.length)) - 1n, [])
  return { size: best.length, refs: best.map((i) => sorted[i]?.ref ?? '').toSorted(), isExact }
}

/** How long each task still needs, longest chain to the end first: the order in which ready tasks are started. */
function ranks(tasks: readonly Task[]): ReadonlyMap<string, number> {
  const dependents = new Map<string, Task[]>()
  for (const task of tasks) for (const ref of task.blockedBy) dependents.set(ref, [...(dependents.get(ref) ?? []), task])
  const rank = new Map<string, number>()
  for (const task of inOrder(tasks).toReversed()) rank.set(task.ref, pointsOf(task) + Math.max(0, ...(dependents.get(task.ref) ?? []).map((one) => rank.get(one.ref) ?? 0)))
  return rank
}

const EPSILON = 1e-9

/**
 * When everything is done with `people` members, in points of time. The work in progress runs from the start (its full points: how far it is is not known),
 * and a member that is free starts the ready issue with the longest chain behind it, if no running issue is in one of its areas.
 */
export function finishTime(tasks: readonly Task[], people: number): number {
  if (tasks.length === 0) return 0
  const rank = ranks(tasks)
  const done = new Set<string>()
  const started = new Set<string>()
  let running: { readonly task: Task; readonly end: number }[] = []
  let now = 0
  const start = (task: Task): void => {
    started.add(task.ref)
    running = [...running, { task, end: now + pointsOf(task) }]
  }
  for (const task of tasks.filter((one) => one.status === 'inProgress')) start(task)
  for (;;) {
    const busyAreas = (): Set<string> => new Set(running.flatMap((one) => one.task.areas))
    const ready = (): Task[] =>
      tasks
        .filter((task) => !started.has(task.ref) && task.blockedBy.every((ref) => done.has(ref)) && !task.areas.some((area) => busyAreas().has(area)))
        .toSorted((a, b) => (rank.get(b.ref) ?? 0) - (rank.get(a.ref) ?? 0) || a.ref.localeCompare(b.ref))
    for (let next = ready()[0]; next !== undefined && running.length < Math.max(1, people); next = ready()[0]) start(next)
    if (running.length === 0) break
    const soonest = Math.min(...running.map((one) => one.end))
    now = soonest
    for (const one of running.filter((one) => one.end <= soonest + EPSILON)) done.add(one.task.ref)
    running = running.filter((one) => one.end > soonest + EPSILON)
    if (done.size === tasks.length) break
  }
  return now
}

export type StaffingPoint = { readonly people: number; /** The shortest time found with this many members or fewer */ readonly time: number }

/**
 * The time for each number of members from 1 to the width plus one (and at least `people`), and the number at which another member stops helping: the
 * first one whose next member does not shorten it. The list schedule is a heuristic and can do worse with more members, so a number is the best of those
 * up to it.
 */
export function staffing(tasks: readonly Task[], width: number, people: number): { readonly curve: readonly StaffingPoint[]; readonly stopsHelping: number } {
  const top = Math.max(width + 1, people, 1)
  const times = Array.from({ length: top }, (_, i) => finishTime(tasks, i + 1))
  const curve = times.map((_, i): StaffingPoint => ({ people: i + 1, time: Math.min(...times.slice(0, i + 1)) }))
  const next = curve.findIndex((point, i) => i + 1 < curve.length && (curve[i + 1]?.time ?? 0) >= point.time - EPSILON)
  return { curve, stopsHelping: next === -1 ? top : (curve[next]?.people ?? top) }
}

/** The fewest members whose time fits in `limit`, or null when none up to the end of the curve does. */
export function fewestWithin(curve: readonly StaffingPoint[], limit: number): number | null {
  return curve.find((point) => point.time <= limit + EPSILON)?.people ?? null
}
