import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { itemNodeSelection } from '../src/adapters/github/item-node.ts'
import { parseItemPages } from '../src/adapters/github/project-board.ts'
import { doneAtOf, EMPTY_DONE_TIMES, epicDoneAt, finishedAtOf, readDoneTimes, recordDone, type DoneTimes } from '../src/agency-runtime/done-at.ts'
import { epicForecasts } from '../src/agency-runtime/epics.ts'
import { parseRuntime } from '../src/agency-runtime/config.ts'
import { buildTeamView } from '../src/agency-runtime/view.ts'
import { refreshSnapshot } from '../src/board/snapshot.ts'
import type { BoardItem, Snapshot } from '../src/board/types.ts'
import type { BoardSource } from '../src/ports/index.ts'
import { paths, type Paths } from '../src/store.ts'
import { board, config } from './agency-runtime-board.ts'
import { issue, NOW, REPO } from './helpers.ts'

const at = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const snapshotOf = (items: readonly BoardItem[], fetchedAt: Date = NOW): Snapshot => ({ fetchedAt: fetchedAt.toISOString(), items, openIssues: [] })
const { statuses } = config

describe('recording when items reach done', () => {
  const before = snapshotOf([issue(1, { status: statuses.doing }), issue(2, { status: statuses.release }), issue(3, { status: statuses.done })], new Date(NOW.getTime() - 300_000))

  it('records the time of the read for an item that became finished, and for one that became done', () => {
    const after = snapshotOf([issue(1, { status: statuses.done }), issue(2, { status: statuses.done }), issue(3, { status: statuses.done })])
    const times = recordDone(before, after, config, EMPTY_DONE_TIMES)
    assert.deepEqual(times.entries, { 'app#1': { finishedAt: NOW.toISOString(), doneAt: NOW.toISOString() }, 'app#2': { doneAt: NOW.toISOString() } })
  })

  it('records release as finished but not as done', () => {
    const times = recordDone(before, snapshotOf([issue(1, { status: statuses.release }), issue(2, { status: statuses.release }), issue(3, { status: statuses.done })]), config, EMPTY_DONE_TIMES)
    assert.deepEqual(times.entries, { 'app#1': { finishedAt: NOW.toISOString() } })
  })

  it('records nothing without a previous read, for an item the previous read did not have, or for a PR', () => {
    const done = snapshotOf([issue(1, { status: statuses.done }), issue(9, { status: statuses.done }), issue(7, { kind: 'pr', status: statuses.done })])
    assert.equal(recordDone(null, done, config, EMPTY_DONE_TIMES), EMPTY_DONE_TIMES)
    assert.deepEqual(recordDone(snapshotOf([issue(1, { status: statuses.doing }), issue(7, { kind: 'pr', status: statuses.doing })]), done, config, EMPTY_DONE_TIMES).entries, { 'app#1': { finishedAt: NOW.toISOString(), doneAt: NOW.toISOString() } })
  })

  it('keeps the first time when an item goes back and is done again, and returns the same object when nothing changed', () => {
    const first: DoneTimes = { version: 1, entries: { 'app#1': { finishedAt: at(600), doneAt: at(600) } } }
    const back = snapshotOf([issue(1, { status: statuses.doing })], new Date(NOW.getTime() - 120_000))
    const again = recordDone(back, snapshotOf([issue(1, { status: statuses.done })]), config, first)
    assert.equal(again, first)
    assert.equal(recordDone(before, before, config, first), first)
  })
})

describe('when an item or an epic is done', () => {
  const times: DoneTimes = { version: 1, entries: { 'app#1': { finishedAt: at(300), doneAt: at(200) }, 'app#2': { finishedAt: at(100) } } }

  it('is the earlier of what the harness saw and the tracker\'s close time, and only while the item is done', () => {
    assert.equal(doneAtOf(issue(1, { status: statuses.done }), times, config), at(200))
    assert.equal(doneAtOf(issue(1, { status: statuses.done, state: 'CLOSED', closedAt: at(500) }), times, config), at(500))
    assert.equal(doneAtOf(issue(1, { status: statuses.done, state: 'CLOSED', closedAt: at(50) }), times, config), at(200))
    assert.equal(doneAtOf(issue(1, { status: statuses.doing }), times, config), undefined)
    assert.equal(doneAtOf(issue(2, { status: statuses.release }), times, config), undefined)
  })

  it('uses the close time of a closed issue the harness never saw finish, and nothing for an open one it did not', () => {
    assert.equal(doneAtOf(issue(8, { status: statuses.done, state: 'CLOSED', closedAt: at(900) }), EMPTY_DONE_TIMES, config), at(900))
    assert.equal(doneAtOf(issue(8, { status: statuses.done, state: 'OPEN', closedAt: at(900) }), EMPTY_DONE_TIMES, config), undefined)
    assert.equal(doneAtOf(issue(8, { status: statuses.done }), EMPTY_DONE_TIMES, config), undefined)
  })

  it('counts release as finished for an epic, and is the time of the last child', () => {
    assert.equal(finishedAtOf(issue(2, { status: statuses.release }), times, config), at(100))
    assert.equal(epicDoneAt([issue(1, { status: statuses.done }), issue(2, { status: statuses.release })], times, config), at(100))
  })

  it('is not known unless every child is finished and every time is known', () => {
    assert.equal(epicDoneAt([issue(1, { status: statuses.done }), issue(3, { status: statuses.doing })], times, config), undefined)
    assert.equal(epicDoneAt([issue(1, { status: statuses.done }), issue(9, { status: statuses.done })], times, config), undefined)
    assert.equal(epicDoneAt([], times, config), undefined)
  })
})

describe('the team view with done times', () => {
  const view = (items: readonly BoardItem[], times: DoneTimes, cfg = config) => buildTeamView({ org: 'acme', team: 'app', label: 'App', config: cfg, snapshot: { ...board(), items }, members: [], stored: [], now: NOW, doneTimes: times })
  const parent = issue(100, { title: 'Epic', status: statuses.doing })
  const child = (number: number, status: string, extra: Partial<BoardItem> = {}) => issue(number, { status, epic: 'app#100', ...extra })

  it('gives a work item that is done and still open its time, and leaves it out for any other item', () => {
    const items = [issue(1, { status: statuses.done }), issue(2, { status: statuses.doing })]
    const { work } = view(items, { version: 1, entries: { 'app#1': { doneAt: at(60) }, 'app#2': { doneAt: at(60) } } })
    assert.deepEqual(work.map((one) => [one.ref, one.doneAt]), [['app#1', at(60)], ['app#2', undefined]])
    assert.equal(work.some((one) => 'doneAt' in one && one.doneAt === undefined), false)
  })

  it('keeps an epic in the view for 30 days after its last child was finished, with the time, then drops it', () => {
    const items = [parent, child(1, statuses.done, { state: 'CLOSED' }), child(2, statuses.release)]
    const recent = view(items, { version: 1, entries: { 'app#1': { finishedAt: at(60) }, 'app#2': { finishedAt: at(10) } } }).epics
    assert.deepEqual(recent.map((one) => [one.ref, one.done, one.total, one.doneAt]), [['app#100', 2, 2, at(10)]])
    const old = view(items, { version: 1, entries: { 'app#1': { finishedAt: at(32 * 24 * 60) }, 'app#2': { finishedAt: at(31 * 24 * 60) } } }).epics
    assert.deepEqual(old, [])
  })

  it('does not report a finished epic whose time is not known, and leaves doneAt out of an epic that is not finished', () => {
    assert.deepEqual(view([parent, child(1, statuses.done, { state: 'CLOSED' }), child(2, statuses.done, { state: 'CLOSED' })], EMPTY_DONE_TIMES).epics, [])
    const open = view([parent, child(1, statuses.done), child(2, statuses.doing)], { version: 1, entries: { 'app#1': { finishedAt: at(5) } } }).epics
    assert.deepEqual(open.map((one) => [one.done, one.total, 'doneAt' in one]), [[1, 2, false]])
  })

  it('takes the number of days from the runtime settings, and 0 drops a finished epic at once', () => {
    const items = [parent, child(1, statuses.done)]
    const times: DoneTimes = { version: 1, entries: { 'app#1': { finishedAt: at(60) } } }
    assert.equal(view(items, times, { ...config, runtime: { finishedEpicDays: 0 } }).epics.length, 0)
    assert.equal(view(items, times, { ...config, runtime: { finishedEpicDays: 1 } }).epics.length, 1)
    assert.equal(parseRuntime({ finishedEpicDays: 7 })?.finishedEpicDays, 7)
    assert.equal(parseRuntime({ finishedEpicDays: -1 }), undefined)
    assert.equal(parseRuntime({ finishedEpicDays: 1.5 }), undefined)
  })
})

describe('the refresh records done times, and the read asks for the close time', () => {
  let p: Paths
  let reads: Snapshot[]
  const source: BoardSource = { fetchSnapshot: () => reads.shift() as Snapshot, statusEvents: () => new Map() }
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-done-at-')))
    mkdirSync(join(p.dir, 'cache'), { recursive: true })
  })

  it('writes the time an item was first seen done, and keeps it across later reads', () => {
    const t1 = new Date(NOW.getTime() - 600_000)
    const t2 = new Date(NOW.getTime() - 300_000)
    reads = [snapshotOf([issue(1, { status: statuses.doing })], t1), snapshotOf([issue(1, { status: statuses.done })], t2), snapshotOf([issue(1, { status: statuses.done })], NOW)]
    refreshSnapshot(p, config, t1, source)
    refreshSnapshot(p, config, t2, source)
    refreshSnapshot(p, config, NOW, source)
    assert.deepEqual(readDoneTimes(p.doneTimes).entries, { 'app#1': { finishedAt: t2.toISOString(), doneAt: t2.toISOString() } })
  })

  it('asks GitHub for the close time of an issue and keeps it on the item', () => {
    assert.match(itemNodeSelection(config), /on Issue\{.*? closedAt/s)
    const nodes = [{ id: 'i1', type: 'ISSUE', content: { number: 1, title: 't', state: 'CLOSED', closedAt: '2026-11-24T10:00:00Z', repository: { nameWithOwner: REPO } } }, { id: 'i2', type: 'ISSUE', content: { number: 2, title: 't', state: 'OPEN', repository: { nameWithOwner: REPO } } }]
    const items = parseItemPages(JSON.stringify([{ data: { node: { items: { totalCount: 2, nodes } } } }]))
    assert.deepEqual(items.map((one) => one.closedAt), ['2026-11-24T10:00:00Z', undefined])
  })
})
