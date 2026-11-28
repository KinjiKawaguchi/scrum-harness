import { blockedReasonOf, workStatusOf } from '../agency-runtime/work.ts'
import { isEpic, label } from '../board/rules.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { ItemRelations } from '../ports/index.ts'

/** The prefix of the labels that name an area of the code. Two issues that name the same area conflict when they run at once. */
export const AREA_PREFIX = 'area:'

/** An open issue that is work to do: not an epic (nobody works on it itself), and in Backlog, Next, or In Progress. */
export type Task = {
  readonly ref: string
  readonly title: string
  readonly points: number | null
  readonly areas: readonly string[]
  /** The issues that still block it and are on the board as work; a blocker that is closed has done its part */
  readonly blockedBy: readonly string[]
  /** Open blockers that are not work on this board (an epic, another team's issue, one that is not on the board) */
  readonly outsideBlockers: readonly string[]
  readonly status: 'backlog' | 'next' | 'inProgress'
  readonly assignee: string | null
  /** Set when the board says it waits for the owner (a decision) or for an outside event */
  readonly wait: { readonly kind: 'person' | 'outside'; readonly why: string } | null
}

/** Why a task cannot be put in the schedule. */
export type Excluded =
  | { readonly kind: 'waiting'; readonly task: Task; readonly who: 'person' | 'outside'; readonly why: string }
  | { readonly kind: 'behindWait'; readonly task: Task; readonly via: string }
  | { readonly kind: 'unestimated'; readonly task: Task }
  | { readonly kind: 'behindUnestimated'; readonly task: Task; readonly via: string }
  | { readonly kind: 'cycle'; readonly task: Task; readonly members: readonly string[] }

export type Classified = {
  /** Estimated, not waiting, and not behind one that is: what the plan is made of */
  readonly schedulable: readonly Task[]
  readonly excluded: readonly Excluded[]
}

const WORK = new Set<Task['status']>(['backlog', 'next', 'inProgress'])

const hasPoints = (item: BoardItem): boolean => typeof item.points === 'number' && Number.isFinite(item.points) && item.points >= 0

/** The areas named by an issue's labels, without the prefix, sorted. */
export const areasOf = (labels: readonly string[]): readonly string[] => [...new Set(labels.filter((name) => name.startsWith(AREA_PREFIX) && name.length > AREA_PREFIX.length).map((name) => name.slice(AREA_PREFIX.length)))].toSorted()

/** The wait that the board says an issue is in: the owner's decision, or an outside event or equipment. A block on the previous issue is a dependency, which GitHub's dependencies say. */
function waitOf(item: BoardItem, config: Config): Task['wait'] {
  const reason = blockedReasonOf(item, config)
  if (reason === 'needsDecision') return { kind: 'person', why: item.reason ?? 'needs a decision' }
  if (reason === 'external' || reason === 'timeOrEquipment') return { kind: 'outside', why: item.reason ?? 'outside' }
  return null
}

/**
 * The open issues that are work, with their points, areas, and blockers. `relations` has the labels and the open blockers of each issue; without an entry
 * for an issue (it could not be read) the issue has no areas and no blockers, which the caller says.
 */
export function tasksOf(snapshot: Snapshot, relations: ReadonlyMap<string, ItemRelations>, config: Config): readonly Task[] {
  const items = snapshot.items
  const open = items.filter((item) => item.kind === 'issue' && item.state === 'OPEN' && !config.excludeAuthors.includes(item.author ?? ''))
  const work = open.filter((item) => {
    const status = workStatusOf(item, config)
    return status !== null && WORK.has(status as Task['status']) && !isEpic(item, items)
  })
  const refs = new Set(work.map(label))
  return work.map((item): Task => {
    const found = relations.get(label(item))
    const blockers = found?.blockedBy ?? []
    return {
      ref: label(item),
      title: item.title,
      points: hasPoints(item) ? (item.points as number) : null,
      areas: areasOf(found?.labels ?? item.labels ?? []),
      blockedBy: blockers.filter((ref) => refs.has(ref) && ref !== label(item)).toSorted(),
      outsideBlockers: blockers.filter((ref) => !refs.has(ref)).toSorted(),
      status: workStatusOf(item, config) as Task['status'],
      assignee: item.assignee,
      wait: waitOf(item, config),
    }
  })
}

/** The tasks that are in a cycle of dependencies, by Tarjan's strongly connected components: each with the members of its cycle. */
function cycles(tasks: readonly Task[]): ReadonlyMap<string, readonly string[]> {
  const byRef = new Map(tasks.map((task) => [task.ref, task]))
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const found = new Map<string, readonly string[]>()
  let counter = 0
  const visit = (ref: string): void => {
    index.set(ref, counter)
    low.set(ref, counter)
    counter += 1
    stack.push(ref)
    onStack.add(ref)
    for (const next of byRef.get(ref)?.blockedBy ?? []) {
      if (!index.has(next)) {
        visit(next)
        low.set(ref, Math.min(low.get(ref) ?? 0, low.get(next) ?? 0))
      } else if (onStack.has(next)) low.set(ref, Math.min(low.get(ref) ?? 0, index.get(next) ?? 0))
    }
    if (low.get(ref) !== index.get(ref)) return
    const component: string[] = []
    for (;;) {
      const top = stack.pop() as string
      onStack.delete(top)
      component.push(top)
      if (top === ref) break
    }
    const isSelfLoop = component.length === 1 && (byRef.get(ref)?.blockedBy ?? []).includes(ref)
    if (component.length > 1 || isSelfLoop) for (const member of component) found.set(member, component.toSorted())
  }
  for (const task of tasks) if (!index.has(task.ref)) visit(task.ref)
  return found
}

/**
 * Sorts the tasks into what the plan is made of and what is left out, and says why: waiting for the owner or an outside event (no staffing moves it), without
 * points, in a cycle, or blocked by one of those (its time cannot be known). A task is never given a number it was not given.
 */
export function classify(tasks: readonly Task[]): Classified {
  const byRef = new Map(tasks.map((task) => [task.ref, task]))
  const inCycle = cycles(tasks)
  const verdict = new Map<string, Excluded | null>()
  const decide = (task: Task): Excluded | null => {
    const cached = verdict.get(task.ref)
    if (cached !== undefined) return cached
    const cycle = inCycle.get(task.ref)
    if (cycle !== undefined) {
      // answered before the blockers are looked at, so a cycle does not recurse for ever
      const own: Excluded = { kind: 'cycle', task, members: cycle }
      verdict.set(task.ref, own)
      return own
    }
    const outside = task.outsideBlockers[0]
    const blockers = task.blockedBy.flatMap((ref) => {
      const blocker = byRef.get(ref)
      return blocker === undefined ? [] : [{ ref, verdict: decide(blocker) }]
    })
    const viaCycle = blockers.find((one) => one.verdict?.kind === 'cycle')
    const viaWait = blockers.find((one) => one.verdict?.kind === 'waiting' || one.verdict?.kind === 'behindWait')
    const viaUnknown = blockers.find((one) => one.verdict?.kind === 'unestimated' || one.verdict?.kind === 'behindUnestimated')
    const result: Excluded | null =
      task.wait !== null
        ? { kind: 'waiting', task, who: task.wait.kind, why: task.wait.why }
        : outside !== undefined
          ? { kind: 'waiting', task, who: 'outside', why: `blocked by ${outside}, which is not work on this board` }
          : viaCycle !== undefined
            ? { kind: 'cycle', task, members: (viaCycle.verdict as Extract<Excluded, { kind: 'cycle' }>).members }
            : viaWait !== undefined
              ? { kind: 'behindWait', task, via: viaWait.ref }
              : task.points === null
                ? { kind: 'unestimated', task }
                : viaUnknown !== undefined
                  ? { kind: 'behindUnestimated', task, via: viaUnknown.ref }
                  : null
    verdict.set(task.ref, result)
    return result
  }
  const decided = tasks.map((task) => [task, decide(task)] as const)
  return { schedulable: decided.flatMap(([task, why]) => (why === null ? [task] : [])), excluded: decided.flatMap(([, why]) => (why === null ? [] : [why])) }
}
