import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { runRuntime, type RuntimeDeps } from '../src/agency-runtime/handle.ts'
import type { TeamView } from '../src/agency-runtime/types.ts'
import { teamViewProblem } from '../src/agency-runtime/validate.ts'
import { paths, type Paths } from '../src/store.ts'
import { keysOf, sample } from './agency-runtime-fixture.ts'
import { board, config, sessions, statuses } from './agency-runtime-board.ts'
import { fakePorts } from './fake-ports.ts'
import { NOW } from './helpers.ts'

let p: Paths
let refreshes = 0

const deps = (overrides: Partial<RuntimeDeps> = {}): RuntimeDeps => ({
  p,
  config,
  now: NOW,
  ports: { ...fakePorts(), sessions: { find: () => ({ name: null, pid: null }), signals: () => sessions } },
  spawnRefresh: () => {
    refreshes += 1
  },
  ...overrides,
})

const request = (op: string, extra: object = {}): string => JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op, ...extra })

function view(overrides: Partial<RuntimeDeps> = {}): TeamView {
  const output = runRuntime(request('view'), deps(overrides))
  assert.equal(output.exitCode, 0, output.stdout)
  return (JSON.parse(output.stdout) as { result: TeamView }).result
}

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-runtime-view-')))
  refreshes = 0
  saveSnapshot(p, board())
})

describe('agency-runtime/1 view', () => {
  it('produces a TeamView that deserializes like the shared sample', () => {
    const result = view()
    assert.equal(teamViewProblem(result), null)
    assert.equal(teamViewProblem(sample()), null)
  })

  it('uses only keys that the shared sample also uses', () => {
    const known = keysOf(sample())
    const unknown = [...keysOf(view())].filter((key) => !known.has(key))
    assert.deepEqual(unknown, [])
  })

  it('names the team after the request, and the time after the board', () => {
    const result = view()
    assert.deepEqual([result.org, result.team, result.label], ['acme', 'app', 'app'])
    assert.equal(result.generatedAt, board().fetchedAt)
    assert.equal(view({ config: { ...config, runtime: { label: 'App' } } }).label, 'App')
  })

  it('reports the lead, the members, and the owner', () => {
    const people = view().people
    assert.deepEqual(people.map((one) => [one.id, one.role, one.kind, one.state]), [
      ['TechLead', 'lead', 'agent', 'working'],
      ['SWE1', 'member', 'agent', 'working'],
      ['SWE2', 'member', 'agent', 'idle'],
      ['SWE3', 'member', 'agent', 'away'],
      ['owner', 'member', 'human', 'unknown'],
    ])
  })

  it('reports a permission prompt as working, waiting on the owner', () => {
    const swe1 = view().people.find((one) => one.id === 'SWE1')
    assert.deepEqual(swe1?.waitingOn, { kind: 'person', person: 'owner' })
    assert.match(swe1?.status ?? '', /^Permission prompt/)
    assert.deepEqual(swe1?.holding, ['app#12'])
  })

  it('reports a long idle member as waiting on the lead, with the idle time and the Next count', () => {
    const swe2 = view().people.find((one) => one.id === 'SWE2')
    assert.deepEqual(swe2?.waitingOn, { kind: 'lead' })
    assert.equal(swe2?.status, 'Idle for 30 minutes; 1 in Next')
    assert.deepEqual(swe2?.holding, ['app#15'])
  })

  it('does not make a short idle wait on the lead', () => {
    const shortIdle = { ...fakePorts().sessions, signals: () => sessions.map((one) => (one.name === 'SWE2' ? { ...one, since: NOW.toISOString(), updatedAt: NOW.toISOString() } : one)) }
    const swe2 = view({ ports: { ...fakePorts(), sessions: shortIdle } }).people.find((one) => one.id === 'SWE2')
    assert.equal(swe2?.waitingOn, undefined)
  })

  it('reports a member without a session as away, with no start time', () => {
    const swe3 = view().people.find((one) => one.id === 'SWE3')
    assert.deepEqual([swe3?.state, swe3?.since, swe3?.status], ['away', undefined, 'No live session'])
  })

  it('turns an item blocked on a decision into a pending decision for the owner', () => {
    const { requests, people } = view()
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0], {
      id: 'app#14',
      kind: 'pendingDecision',
      title: 'Drop the old export?',
      context: 'Blocked on a decision since 2026-10-07.',
      from: 'board',
      createdAt: '2026-10-07T00:00:00Z',
      issue: 'app#14',
      blocks: ['app#14'],
      options: [],
      answerWith: { kind: 'judge', target: 'app#14' },
    })
    assert.equal(people.at(-1)?.status, '1 request is waiting for an answer')
  })

  it('lists open issues as work, without parents, closed items, outside authors, and unknown statuses', () => {
    const refs = view().work.map((item) => item.ref)
    assert.deepEqual(refs.toSorted(), ['app#11', 'app#12', 'app#14', 'app#15', 'app#16'])
  })

  it('maps statuses, assignees, parents, and whole-number points', () => {
    const byRef = Object.fromEntries(view().work.map((item) => [item.ref, item]))
    assert.deepEqual(byRef['app#12'], { ref: 'app#12', title: 'Store sessions', status: 'inProgress', assignee: 'SWE1', epic: 'app#100', points: 3 })
    assert.equal(byRef['app#11']?.status, 'release')
    assert.equal(byRef['app#16']?.points, undefined)
  })

  it('maps blocked reasons: a decision, a configured name, an unlisted name, and a missing start date', () => {
    const byRef = Object.fromEntries(view().work.map((item) => [item.ref, item]))
    assert.deepEqual(byRef['app#14']?.blocked, { reason: 'needsDecision', since: '2026-10-07' })
    assert.deepEqual(byRef['app#15']?.blocked, { reason: 'waitingOnPrevious', since: '2026-10-08' })
    assert.deepEqual(byRef['app#16']?.blocked, { reason: 'external', since: '2026-10-08' })
    assert.equal(byRef['app#12']?.blocked, undefined)
  })

  it('counts an epic from its children, without a forecast', () => {
    const [epic, ...rest] = view().epics
    assert.equal(rest.length, 0)
    assert.deepEqual(epic, {
      ref: 'app#100',
      title: 'Persistent sessions',
      total: 4,
      done: 1,
      doing: 1,
      remainingPoints: 5,
      blocked: [
        { reason: 'needsDecision', count: 1 },
        { reason: 'waitingOnPrevious', count: 1 },
      ],
      basis: 'No forecast: this harness does not compute throughput',
    })
  })

  it('leaves an epic out once all its children are finished', () => {
    const finished = { ...board(), items: board().items.map((item) => (item.epic === 'app#100' ? { ...item, status: statuses.done } : item)) }
    saveSnapshot(p, finished)
    assert.deepEqual(view().epics, [])
  })
})

describe('agency-runtime/1 view and the board', () => {
  it('starts a refresh and refuses while there is no board yet', () => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-runtime-empty-')))
    const output = runRuntime(request('view'), deps())
    assert.equal(output.exitCode, 1)
    assert.equal((JSON.parse(output.stdout) as { error: { status: number } }).error.status, 503)
    assert.equal(refreshes, 1)
  })

  it('answers from a stale board and starts a refresh in the background', () => {
    saveSnapshot(p, board(new Date(NOW.getTime() - 60 * 60_000)))
    assert.equal(view().requests.length, 1)
    assert.equal(refreshes, 1)
  })

  it('does not start a refresh while the board is fresh', () => {
    view()
    assert.equal(refreshes, 0)
  })

  it('refuses with a 503 when the board cannot be turned into a view', () => {
    saveSnapshot(p, { ...board(), fetchedAt: 'not a time' })
    const output = runRuntime(request('view'), deps())
    assert.equal(output.exitCode, 1)
    assert.equal((JSON.parse(output.stdout) as { error: { status: number } }).error.status, 503)
  })
})
