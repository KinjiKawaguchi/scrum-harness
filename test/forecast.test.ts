import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { relationsFor, relationsQuery } from '../src/adapters/github/relations.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import type { BoardItem } from '../src/board/types.ts'
import { endOfDay, forecastCommand } from '../src/forecast/command.ts'
import { forecast } from '../src/forecast/forecast.ts'
import { areasOf, classify, tasksOf, type Task } from '../src/forecast/model.ts'
import { areaLoads, conflictsOf, criticalPath, finishTime, staffing, usefulParallelism } from '../src/forecast/plan.ts'
import { formatForecast } from '../src/forecast/report.ts'
import { measureVelocity, mergeRate } from '../src/forecast/velocity.ts'
import type { ItemRelations } from '../src/ports/index.ts'
import type { StatusEvent } from '../src/sprint/effort.ts'
import { paths, type Paths } from '../src/store.ts'
import { itemNodeSelection } from '../src/adapters/github/item-node.ts'
import { parseConfig } from '../src/config.ts'
import { fakePorts } from './fake-ports.ts'
import { config, issue, NOW, pr, snapshot } from './helpers.ts'

const HOUR = 3_600_000
const ago = (hours: number): string => new Date(NOW.getTime() - hours * HOUR).toISOString()

/** A board of six issues: 1 > 2 in core, 3 > 4 in web (the longest chain), 5 alone in node, and 6 in core with no dependency. */
const SIX: readonly BoardItem[] = [
  issue(1, { status: 'Next', points: 3 }),
  issue(2, { status: 'Next', points: 2 }),
  issue(3, { status: 'Next', points: 4 }),
  issue(4, { status: 'Backlog', points: 2 }),
  issue(5, { status: 'Backlog', points: 3 }),
  issue(6, { status: 'Backlog', points: 1 }),
]
const rel = (labels: readonly string[], blockedBy: readonly string[] = []): ItemRelations => ({ labels, blockedBy })
const SIX_RELATIONS = new Map<string, ItemRelations>([
  ['app#1', rel(['area:core'])],
  ['app#2', rel(['area:core'], ['app#1'])],
  ['app#3', rel(['area:web'])],
  ['app#4', rel(['area:web'], ['app#3'])],
  ['app#5', rel(['area:node'])],
  ['app#6', rel(['area:core', 'bug'])],
])
const tasksOfSix = (): readonly Task[] => tasksOf(snapshot(SIX), SIX_RELATIONS, config)

describe('the tasks of a board', () => {
  it('are the open issues in Backlog, Next, and In Progress, with their points, areas, and open blockers', () => {
    const [one, two] = tasksOfSix()
    assert.deepEqual([one?.ref, one?.points, one?.areas, one?.blockedBy], ['app#1', 3, ['core'], []])
    assert.deepEqual([two?.blockedBy, two?.status], [['app#1'], 'next'])
  })

  it('leave out an epic (an issue with sub-issues, or one others name as parent), a finished or closed issue, a pull request, and an issue of an excluded author', () => {
    const items = [issue(1, { points: 2 }), issue(2, { points: 2, subIssues: 3 }), issue(3, { points: 1, epic: 'app#1' }), issue(4, { status: 'Release', points: 1 }), issue(5, { state: 'CLOSED' }), pr(6), issue(7, { author: 'external-dev', points: 1 })]
    assert.deepEqual(tasksOf(snapshot(items), new Map(), config).map((task) => task.ref), ['app#3'])
  })

  it('read the areas from `area:` labels only, sorted, once each', () => {
    assert.deepEqual(areasOf(['bug', 'area:web', 'area:core', 'area:web', 'area:']), ['core', 'web'])
  })

  it('say a blocker that is not work on the board is outside, and a self-reference is no blocker', () => {
    const [task] = tasksOf(snapshot([issue(1, { points: 1 })]), new Map([['app#1', rel([], ['app#1', 'other#9'])]]), config)
    assert.deepEqual([task?.blockedBy, task?.outsideBlockers], [[], ['other#9']])
  })
})

describe('what the plan is made of', () => {
  const work = (items: readonly BoardItem[], relations: Record<string, ItemRelations> = {}) => classify(tasksOf(snapshot(items), new Map(Object.entries(relations)), config))
  const why = (c: ReturnType<typeof classify>) => c.excluded.map((one) => `${one.task.ref}:${one.kind}`)

  it('leaves out what waits for the owner or an outside event, and what is blocked by it, since no staffing moves it', () => {
    const c = work([issue(1, { points: 2, reason: 'Needs decision' }), issue(2, { points: 2 }), issue(3, { points: 2, reason: 'External' }), issue(4, { points: 3 })], { 'app#2': rel([], ['app#1']) })
    assert.deepEqual(why(c), ['app#1:waiting', 'app#2:behindWait', 'app#3:waiting'])
    assert.deepEqual(c.schedulable.map((task) => task.ref), ['app#4'])
    assert.equal((c.excluded[0] as { who: string }).who, 'person')
  })

  it('treats a block on the previous issue as a dependency (the tracker says which), not as a wait', () => {
    const waiting = { ...config, runtime: { blockedReasons: { waitingOnPrevious: 'Waiting on previous' } } }
    const c = classify(tasksOf(snapshot([issue(1, { points: 2, reason: 'Waiting on previous' })]), new Map(), waiting))
    assert.deepEqual(c.schedulable.map((task) => task.ref), ['app#1'])
  })

  it('lists an issue without points as unestimated, and leaves out what it blocks, whose start is not known', () => {
    const c = work([issue(1), issue(2, { points: 3 }), issue(3, { points: 2 })], { 'app#2': rel([], ['app#1']) })
    assert.deepEqual(why(c), ['app#1:unestimated', 'app#2:behindUnestimated'])
    assert.deepEqual(c.schedulable.map((task) => task.ref), ['app#3'])
  })

  it('leaves out a cycle of dependencies, and what is behind it, and does not loop', () => {
    const c = work([issue(1, { points: 1 }), issue(2, { points: 1 }), issue(3, { points: 1 }), issue(4, { points: 1 })], { 'app#1': rel([], ['app#2']), 'app#2': rel([], ['app#1']), 'app#3': rel([], ['app#1']) })
    assert.deepEqual(why(c), ['app#1:cycle', 'app#2:cycle', 'app#3:cycle'])
    assert.deepEqual((c.excluded[0] as unknown as { members: string[] }).members, ['app#1', 'app#2'])
    assert.deepEqual(c.schedulable.map((task) => task.ref), ['app#4'])
  })

  it('leaves out an issue blocked by an open issue that is not work on this board, as waiting on an outside event', () => {
    const c = work([issue(1, { points: 1 })], { 'app#1': rel([], ['other#9']) })
    assert.match((c.excluded[0] as { why: string }).why, /blocked by other#9, which is not work on this board/)
  })
})

describe('the critical path, the areas, and the conflicts', () => {
  it('is the longest chain of dependencies by points', () => {
    assert.deepEqual(criticalPath(tasksOfSix()), { refs: ['app#3', 'app#4'], points: 6 })
    assert.equal(criticalPath([]), null)
  })

  it('follows a long chain through three issues, and takes the heavier of two ways into an issue', () => {
    const items = [issue(1, { points: 1 }), issue(2, { points: 5 }), issue(3, { points: 2 }), issue(4, { points: 1 })]
    const relations = new Map([['app#3', rel([], ['app#1', 'app#2'])], ['app#4', rel([], ['app#3'])]])
    assert.deepEqual(criticalPath(tasksOf(snapshot(items), relations, config)), { refs: ['app#2', 'app#3', 'app#4'], points: 8 })
  })

  it('adds up the points of each area, the biggest first', () => {
    assert.deepEqual(areaLoads(tasksOfSix()).map((one) => [one.area, one.points, one.refs]), [['core', 6, ['app#1', 'app#2', 'app#6']], ['web', 6, ['app#3', 'app#4']], ['node', 3, ['app#5']]])
  })

  it('names the pairs that are ordered by a dependency, and the pairs that share an area and are not', () => {
    const conflicts = conflictsOf(tasksOfSix())
    assert.deepEqual(conflicts.ordered, [['app#1', 'app#2'], ['app#3', 'app#4']])
    assert.deepEqual(conflicts.shared, [['app#1', 'app#6', 'core'], ['app#2', 'app#6', 'core']])
  })

  it('counts an ordering through other issues as a conflict too', () => {
    const items = [issue(1, { points: 1 }), issue(2, { points: 1 }), issue(3, { points: 1 })]
    const conflicts = conflictsOf(tasksOf(snapshot(items), new Map([['app#2', rel([], ['app#1'])], ['app#3', rel([], ['app#2'])]]), config))
    assert.deepEqual(conflicts.ordered, [['app#1', 'app#2'], ['app#1', 'app#3'], ['app#2', 'app#3']])
  })
})

describe('the useful parallelism', () => {
  it('is the widest set that runs at once: none depends on another, none shares an area', () => {
    const width = usefulParallelism(tasksOfSix())
    assert.deepEqual([width.size, width.isExact], [3, true])
    assert.equal(width.refs.includes('app#5'), true)
  })

  it('is every issue when nothing conflicts, and one when everything does', () => {
    const free = Array.from({ length: 12 }, (_, i) => issue(i + 1, { points: 1 }))
    assert.equal(usefulParallelism(tasksOf(snapshot(free), new Map(), config)).size, 12)
    const sameArea = new Map(free.map((_item, i) => [`app#${i + 1}`, rel(['area:core'])]))
    assert.equal(usefulParallelism(tasksOf(snapshot(free), sameArea, config)).size, 1)
  })

  it('is nothing for no issue', () => {
    assert.deepEqual(usefulParallelism([]), { size: 0, refs: [], isExact: true })
  })
})

describe('the time to finish and the staffing', () => {
  it('is the total with one member, shorter with more, and no shorter than the critical path', () => {
    const tasks = tasksOfSix()
    assert.deepEqual([1, 2, 3, 4, 8].map((people) => finishTime(tasks, people)), [15, 8, 6, 6, 6])
  })

  it('starts the work in progress at once, with its full points, and does not run two issues of one area together', () => {
    const items = [issue(1, { status: 'In Progress', points: 4 }), issue(2, { points: 3 })]
    const same = tasksOf(snapshot(items), new Map([['app#1', rel(['area:core'])], ['app#2', rel(['area:core'])]]), config)
    assert.equal(finishTime(same, 2), 7)
    assert.equal(finishTime(tasksOf(snapshot(items), new Map(), config), 2), 4)
  })

  it('says at which number another member stops helping, and gives the best time up to each number', () => {
    const { curve, stopsHelping } = staffing(tasksOfSix(), 3, 1)
    assert.deepEqual(curve.map((one) => [one.people, one.time]), [[1, 15], [2, 8], [3, 6], [4, 6]])
    assert.equal(stopsHelping, 3)
  })
})

describe('the velocity', () => {
  const finished = (n: number, points: number, hours: number, finishedHoursAgo: number): readonly [BoardItem, readonly StatusEvent[]] => {
    const end = NOW.getTime() - finishedHoursAgo * HOUR
    return [issue(n, { status: 'Release', points, closedAt: new Date(end).toISOString() }), [{ at: new Date(end - hours * HOUR).toISOString(), status: 'In Progress' }, { at: new Date(end).toISOString(), status: 'Release' }]]
  }
  const events = (list: readonly (readonly [BoardItem, readonly StatusEvent[]])[]) => new Map(list.map(([item, one]) => [`app#${item.number}`, one]))

  it('is the points finished over the hours they were In Progress, with the slowest and the fastest quarter', () => {
    const list = [finished(1, 2, 1, 10), finished(2, 4, 2, 20), finished(3, 3, 1, 30), finished(4, 1, 1, 40)]
    const v = measureVelocity(list.map(([item]) => item), events(list), config, NOW)
    assert.equal(v.kind, 'measured')
    if (v.kind === 'measured') assert.deepEqual([v.pointsPerHour, v.samples, v.points, v.hours, v.low, v.high], [2, 4, 10, 5, 1.75, 2.25])
  })

  it('is missing, and says so, with fewer than three issues, or when their Status changes could not be read', () => {
    const list = [finished(1, 2, 1, 10), finished(2, 4, 2, 20)]
    const few = measureVelocity(list.map(([item]) => item), events(list), config, NOW)
    assert.deepEqual(few, { kind: 'missing', why: '2 issues with points finished in the last 7 days with a measurable time In Progress; 3 are needed' })
    assert.match((measureVelocity([], null, config, NOW) as { why: string }).why, /could not be read/)
  })

  it('leaves out an issue that finished before the window, one with no Status changes read, and one that was In Progress for minutes', () => {
    const list = [finished(1, 2, 1, 10), finished(2, 2, 1, 20), finished(3, 2, 1, 30), finished(4, 2, 1, 24 * 8), finished(5, 2, 0.05, 5)]
    const known = events(list.slice(0, 5))
    const v = measureVelocity([...list.map(([item]) => item), issue(6, { status: 'Release', points: 1 })], known, config, NOW)
    assert.equal(v.kind === 'measured' ? v.samples : -1, 3)
    assert.equal(v.kind === 'measured' && v.skipped.some((one) => /app#5.*under 15 minutes/.test(one)) && v.skipped.some((one) => /app#6.*not read/.test(one)), true)
  })

  it('counts the pull requests merged in the last week, and is null when the board has no pull request times', () => {
    const merged = [pr(1, { mergedAt: ago(10) }), pr(2, { mergedAt: ago(30) }), pr(3, { mergedAt: ago(24 * 9) }), pr(4, { openedAt: ago(1) })]
    assert.deepEqual(mergeRate(snapshot(merged), NOW), { merged: 2, perDay: 2 / 7, perHour: 2 / 168 })
    assert.equal(mergeRate(snapshot([pr(5)]), NOW), null)
  })
})

describe('the forecast', () => {
  const finished = [1, 2, 3].map((n) => issue(100 + n, { status: 'Release', points: 2, closedAt: ago(n * 10) }))
  const stamp = (n: number) => {
    const end = NOW.getTime() - n * 10 * HOUR
    return [`app#${100 + n}`, [{ at: new Date(end - HOUR).toISOString(), status: 'In Progress' }, { at: new Date(end).toISOString(), status: 'Release' }]] as const
  }
  const history = new Map([1, 2, 3].map(stamp))
  const board = snapshot([...SIX, ...finished])
  const run = (extra: object = {}, events: typeof history | null = history) => forecast({ snapshot: board, relations: SIX_RELATIONS, events, config, now: NOW, people: 2, ...extra })

  it('gives the finish time with the members, the range at the measured speed, and the members at which another one stops helping', () => {
    const f = run()
    assert.equal(f.velocity.kind, 'measured')
    assert.deepEqual([f.points, f.width?.size, f.critical?.points, f.stopsHelping, f.people], [15, 3, 6, 3, 2])
    // 2 points per hour: 8 points of time with 2 members is 4 hours
    assert.deepEqual(f.answer, { kind: 'known', people: 2, finishHours: 4, range: { fastHours: 4, slowHours: 4 } })
  })

  it('answers a date: reachable with the members now, only with more, or not at all, and says what blocks it', () => {
    const by = (hours: number) => new Date(NOW.getTime() + hours * HOUR)
    assert.deepEqual(run({ by: by(5) }).by?.reachable, { kind: 'yes', people: 2 })
    assert.deepEqual(run({ by: by(3.5) }).by?.reachable, { kind: 'withMore', needed: 3, have: 2 })
    const no = run({ by: by(2) }).by?.reachable
    assert.equal(no?.kind, 'no')
    assert.match(no?.kind === 'no' ? no.detail : '', /longest chain of dependencies \(app#3 > app#4\) takes 3\.0 hours, and 2\.0 hours are left/)
  })

  it('blames an area when the issues that cannot run together are the longest', () => {
    const items = [issue(1, { points: 2 }), issue(2, { points: 2 }), issue(3, { points: 2 })]
    const f = forecast({ snapshot: snapshot([...items, ...finished]), relations: new Map(items.map((_item, i) => [`app#${i + 1}`, rel(['area:core'])])), events: history, config, now: NOW, people: 3, by: new Date(NOW.getTime() + 2 * HOUR) })
    assert.equal(f.by?.reachable.kind === 'no' ? f.by.reachable.blockedBy : '', 'area')
  })

  it('is in points, with no hours and no date, when there is no velocity', () => {
    const f = run({ by: new Date(NOW.getTime() + HOUR) }, null)
    assert.equal(f.answer.kind, 'unknown')
    assert.equal(f.by?.reachable.kind, 'unknown')
    assert.equal(f.critical?.points, 6)
    assert.match(formatForecast(f, 540), /no velocity .*so the work is given in points and not in hours/)
  })

  it('works out no graph when the board source gives no dependencies or labels, and says so', () => {
    const f = forecast({ snapshot: board, relations: null, events: history, config, now: NOW })
    assert.deepEqual([f.hasGraph, f.critical, f.width, f.curve], [false, null, null, []])
    assert.match(formatForecast(f, 0), /Graph: not worked out\. This board source does not give the issues' dependencies/)
  })

  it('lists the issues whose relations could not be read, which count as having none', () => {
    const partial = new Map([...SIX_RELATIONS].filter(([ref]) => ref !== 'app#5'))
    assert.deepEqual(forecast({ snapshot: board, relations: partial, events: history, config, now: NOW }).unread, ['app#5'])
  })

  it('prints each part: velocity, the work and what is left out, the graph, the critical path, the parallelism, the staffing, and the answer', () => {
    const text = formatForecast(run({ by: new Date(NOW.getTime() + 5 * HOUR) }), 540)
    for (const part of [/Velocity \(the last 7 days\)\n  2\.00 points per member-hour/, /merge rate: not read/, /6 issues; 6 issues \(15 points\) are in the plan/, /2 pairs that name the same area/, /Critical path: app#3 > app#4\n  3\.0 hours \(6 points\)/, /Busiest area: core, 3\.0 hours \(6 points\)/, /Useful parallelism: 3 issues can run at once/, /\n   2 \* 4\.0 hours \(8 points\), 2026-10-08 19:00/, /Another member stops helping after 3/, /With 2 members, the plan is done in 4\.0 hours/, /By 2026-10-08 20:00 \(5\.0 hours from now\): reachable with 2 members/]) assert.match(text, part)
  })

  it('lists apart what waits for a person, and says it is not in the times', () => {
    const waiting = snapshot([...SIX, issue(7, { points: 5, reason: 'Needs decision' }), issue(8, { points: 1 }), ...finished])
    const text = formatForecast(forecast({ snapshot: waiting, relations: new Map([...SIX_RELATIONS, ['app#8', rel([], ['app#7'])]]), events: history, config, now: NOW }), 0)
    assert.match(text, /waiting for the owner \(a decision\): 1 issue, 5 points: app#7/)
    assert.match(text, /blocked by one that waits .*app#8 \(after app#7\)/)
    assert.match(text, /Not in these times: 2 issues that wait for the owner or an outside event/)
  })
})

describe('--by', () => {
  it('is the end of that day in the time zone, and nothing when it is not a date', () => {
    assert.equal(endOfDay('2026-12-05', 540)?.toISOString(), '2026-12-05T14:59:59.000Z')
    assert.equal(endOfDay('2026-02-30', 0), null)
    assert.equal(endOfDay('tomorrow', 0), null)
  })
})

describe('scrum forecast', () => {
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-forecast-')))
  })
  const finishedItems = [1, 2, 3].map((n) => issue(100 + n, { status: 'Release', points: 2, closedAt: ago(n * 10) }))
  const stamp = (n: number) => {
    const end = NOW.getTime() - n * 10 * HOUR
    return [`app#${100 + n}`, [{ at: new Date(end - HOUR).toISOString(), status: 'In Progress' }, { at: new Date(end).toISOString(), status: 'Release' }]] as const
  }
  const ports = (overrides: { relations?: () => ReadonlyMap<string, ItemRelations>; events?: () => ReadonlyMap<string, readonly StatusEvent[]> | null; noRelations?: boolean } = {}) => {
    const base = fakePorts()
    const asked: string[][] = []
    return {
      asked,
      ports: fakePorts({
        board: {
          ...base.board,
          statusEvents: overrides.events ?? (() => new Map([1, 2, 3].map(stamp))),
          ...(overrides.noRelations === true ? {} : { relations: overrides.relations ?? ((items) => (asked.push(items.map((item) => `app#${item.number}`)), SIX_RELATIONS)) }),
        },
      }),
    }
  }
  const board = () => saveSnapshot(p, { ...snapshot([...SIX, ...finishedItems, issue(9, { subIssues: 2, status: 'In Progress' })]), fetchedAt: ago(0.5) })
  const run = (flags: Record<string, string | true> = {}, world: Parameters<typeof ports>[0] = {}) => forecastCommand(p, config, ports(world).ports, flags, NOW)

  it('says to refresh when the board has not been read', () => {
    assert.match(run(), /The board has not been read yet: run `scrum refresh` first\./)
  })

  it('prints the report, asks for the relations of the open issues that are not epics, and says how old the board copy is', () => {
    board()
    const world = ports()
    const text = forecastCommand(p, config, world.ports, {}, NOW)
    assert.match(text, /Forecast as of .*\n\nVelocity/)
    assert.match(text, /Critical path: app#3 > app#4/)
    assert.match(text, /From the board copy read 30 minutes ago\./)
    assert.deepEqual(world.asked[0], ['app#1', 'app#2', 'app#3', 'app#4', 'app#5', 'app#6'])
  })

  it('takes --people and --by, refuses what is not a number or a date, and prints JSON with --json', () => {
    board()
    assert.match(run({ people: '3', by: '2026-10-09' }), /By 2026-10-09 23:59 .*: reachable with 3 members/)
    assert.match(run({ people: 'many' }), /--people must be a whole number/)
    assert.match(run({ by: 'soon' }), /--by must be a date/)
    const json = JSON.parse(run({ json: true })) as { criticalPath: { points: number }; answer: { kind: string }; staffing: { stopsHelping: number } }
    assert.deepEqual([json.criticalPath.points, json.answer.kind, json.staffing.stopsHelping], [6, 'known', 3])
  })

  it('says what could not be read, and still gives what it can', () => {
    board()
    const text = run({}, { relations: () => { throw new Error('gh is down') }, events: () => { throw new Error('timeline failed') } })
    assert.match(text, /The dependencies and labels could not be read now \(gh is down\), so the graph is not worked out\./)
    assert.match(text, /The Status changes of the finished issues could not be read \(timeline failed\), so the velocity is not measured\./)
    assert.match(text, /Graph: not worked out/)
  })

  it('says why a read failed in the tracker\'s own words, not with the query it sent', () => {
    board()
    const failure = Object.assign(new Error(`Command failed: gh api graphql -f query=query{ ${'x'.repeat(2000)} }`), { status: 1, stderr: 'gh: API rate limit already exceeded for user ID 1.\n' })
    const text = run({}, { relations: () => { throw failure } })
    assert.match(text, /could not be read now \(gh exited with 1: gh: API rate limit already exceeded for user ID 1\.\)/)
    assert.doesNotMatch(text, /xxxx/)
  })

  it('says the graph is not worked out for a board source that has no relations', () => {
    board()
    assert.match(run({}, { noRelations: true }), /Graph: not worked out/)
  })
})

describe('reading the relations from GitHub', () => {
  const items = [issue(7, { points: 1 }), issue(8, { points: 1 }), issue(9, { points: 1 })]
  const answer = JSON.stringify({
    data: {
      i0: { issue: { labels: { nodes: [{ name: 'area:web' }, { name: 'bug' }] }, blockedBy: { nodes: [{ number: 3, state: 'OPEN', repository: { nameWithOwner: 'example-org/app' } }, { number: 4, state: 'CLOSED', repository: { nameWithOwner: 'example-org/app' } }, { number: 5, state: 'OPEN', repository: { nameWithOwner: 'example-org/other' } }] } } },
      i1: null,
      i2: { issue: { labels: { nodes: [] }, blockedBy: { nodes: [] } } },
    },
  })

  it('asks for the labels and the blockers of each issue, aliased, in one query', () => {
    const query = relationsQuery([{ alias: 'i0', repo: 'example-org/app', number: 7, ref: 'app#7' }])
    assert.equal(query, 'query{ i0: repository(owner:"example-org", name:"app"){ issue(number:7){ labels(first:30){ nodes{ name } } blockedBy(first:30){ nodes{ number state repository{ nameWithOwner } } } } } }')
  })

  it('keeps only the blockers that are still open, as labels, leaves out an issue that could not be read, and reads other issues', () => {
    const calls: string[][] = []
    const map = relationsFor(items, (args) => (calls.push([...args]), answer))
    assert.deepEqual([...map], [['app#7', { labels: ['area:web', 'bug'], blockedBy: ['app#3', 'other#5'] }], ['app#9', { labels: [], blockedBy: [] }]])
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]?.slice(0, 3), ['api', 'graphql', '-f'])
  })

  it('reads in chunks, and refuses a repository or number that cannot be put in a query', () => {
    const many = Array.from({ length: 85 }, (_, i) => issue(i + 1))
    let queries = 0
    relationsFor(many, () => (queries += 1, JSON.stringify({ data: {} })))
    assert.equal(queries, 3)
    assert.throws(() => relationsFor([issue(1, { repo: 'a b/c' })], () => ''), /cannot read the relations of/)
  })
})

describe('reading the points for the forecast', () => {
  it('asks for the number field named in fields.points when there is no sprint section, and not otherwise', () => {
    assert.doesNotMatch(itemNodeSelection(config), /points: fieldValueByName/)
    assert.match(itemNodeSelection({ ...config, fields: { ...config.fields, points: 'Points' } }), /points: fieldValueByName\(name:"Points"\)\{ \.\.\. on ProjectV2ItemFieldNumberValue\{ number \}/)
  })

  it('takes a field name, and refuses one that would break the query', () => {
    const raw = JSON.parse(JSON.stringify({ ...config, fields: { ...config.fields, points: 'Points' } })) as Record<string, unknown>
    assert.equal(parseConfig(raw)?.fields.points, 'Points')
    for (const bad of ['', '  ', 'a"b', 'a\\b', 'a\nb', 3]) assert.equal(parseConfig({ ...raw, fields: { ...config.fields, points: bad } }), null, JSON.stringify(bad))
  })

  it('says so when no field is read for the points', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-forecast-points-')))
    saveSnapshot(p, snapshot([issue(1)]))
    assert.match(forecastCommand(p, config, fakePorts(), {}, NOW), /The points are not read: name the board's number field in `fields\.points`/)
    assert.doesNotMatch(forecastCommand(p, { ...config, fields: { ...config.fields, points: 'Points' } }, fakePorts(), {}, NOW), /The points are not read/)
  })
})
