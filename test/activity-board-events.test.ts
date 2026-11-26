import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { itemNodeSelection } from '../src/adapters/github/item-node.ts'
import { parseItemPages } from '../src/adapters/github/project-board.ts'
import { readEvents } from '../src/activity/log.ts'
import { boardEvents } from '../src/activity/board-events.ts'
import { parseRuntime } from '../src/agency-runtime/config.ts'
import { refreshSnapshot } from '../src/board/snapshot.ts'
import type { BoardItem, Snapshot } from '../src/board/types.ts'
import type { BoardSource } from '../src/ports/index.ts'
import { paths, type Paths } from '../src/store.ts'
import { config, issue, NOW, pr, REPO } from './helpers.ts'

const at = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const board = (items: readonly BoardItem[], fetchedAt: Date = NOW): Snapshot => ({ fetchedAt: fetchedAt.toISOString(), items, openIssues: [] })

describe('the board events of a read', () => {
  it('cuts a title at 200 characters, the limit the node applies', () => {
    const long = 'x'.repeat(300)
    const events = boardEvents(null, board([issue(5, { addedAt: at(30), title: long }), pr(9, { openedAt: at(20), title: long })]), config)
    assert.deepEqual(events.map((one) => ('title' in one ? one.title.length : 0)), [200, 200])
  })

  it('names an issue or a task added to the board, at the time GitHub says, with its epic', () => {
    const [event] = boardEvents(null, board([issue(5, { addedAt: at(30), epic: 'app#1', title: 'New work' })]), config)
    assert.deepEqual([event?.kind, event?.at, event?.id.startsWith('b-')], ['itemAdded', at(30), true])
    assert.deepEqual(event && 'ref' in event ? [event.ref, event.title, event.epic] : [], ['app#5', 'New work', 'app#1'])
  })

  it('has nothing for an item whose adding time is not known, and nothing about a pull request added', () => {
    assert.deepEqual(boardEvents(null, board([issue(5), pr(6, { addedAt: at(5) })]), config), [])
  })

  it('names a pull request opened, and merged with the time from opening to merging, and the issue it closes', () => {
    const events = boardEvents(null, board([pr(9, { openedAt: at(120), mergedAt: at(60), closes: 'app#5', title: 'Fix it' })]), config)
    assert.deepEqual(events.map((one) => one.kind), ['prOpened', 'prMerged'])
    assert.deepEqual(events.map((one) => one.at), [at(120), at(60)])
    const merged = events[1]
    assert.deepEqual(merged && merged.kind === 'prMerged' ? [merged.ref, merged.issue, merged.leadSeconds] : [], ['app#9', 'app#5', 3600])
  })

  it('names only the opening of a pull request that is still open, and a merge with no known opening has no lead time', () => {
    assert.deepEqual(boardEvents(null, board([pr(9, { state: 'OPEN', openedAt: at(10) })]), config).map((one) => one.kind), ['prOpened'])
    const merged = boardEvents(null, board([pr(9, { mergedAt: at(10) })]), config)[0]
    assert.equal(merged && merged.kind === 'prMerged' && 'leadSeconds' in merged, false)
  })

  it('leaves out the optional fields it does not have, rather than null', () => {
    const [event] = boardEvents(null, board([pr(9, { openedAt: at(10) })]), config)
    assert.deepEqual(Object.keys(event ?? {}).toSorted(), ['at', 'id', 'kind', 'ref', 'title'])
  })

  it('names a Status change since the previous read, at the time of the new read', () => {
    const before = board([issue(5, { status: 'Backlog' })], new Date(NOW.getTime() - 300_000))
    const events = boardEvents(before, board([issue(5, { status: 'In Progress', epic: 'app#1' })]), config)
    assert.equal(events.length, 1)
    const [event] = events
    assert.deepEqual(event && event.kind === 'statusChanged' ? [event.from, event.to, event.at, event.epic] : [], ['backlog', 'inProgress', NOW.toISOString(), 'app#1'])
  })

  it('has no Status change without a previous read, when the Status is the same, for an unnamed Status, or for a pull request', () => {
    const now = board([issue(5, { status: 'In Progress' })])
    assert.deepEqual(boardEvents(null, now, config), [])
    assert.deepEqual(boardEvents(board([issue(5, { status: 'In Progress' })]), now, config), [])
    assert.deepEqual(boardEvents(board([issue(5, { status: 'Triage' })]), now, config), [])
    assert.deepEqual(boardEvents(board([pr(6, { status: 'Next' })]), board([pr(6, { status: 'Done' })]), config), [])
  })

  it('gives the same read the same events and ids, and a different read different ids', () => {
    const items = [issue(5, { addedAt: at(30) }), pr(9, { openedAt: at(20) })]
    assert.deepEqual(boardEvents(null, board(items), config), boardEvents(null, board(items), config))
    assert.notEqual(boardEvents(null, board([issue(5, { addedAt: at(30) })]), config)[0]?.id, boardEvents(null, board([issue(5, { addedAt: at(31) })]), config)[0]?.id)
  })
})

describe('the refresh writes the board events to the log', () => {
  let p: Paths
  let reads: Snapshot[]
  const source: BoardSource = { fetchSnapshot: () => reads.shift() as Snapshot, statusEvents: () => new Map() }

  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-board-events-')))
    mkdirSync(join(p.dir, 'cache'), { recursive: true })
  })

  it('logs an item added, then a Status change once, and nothing when the next read has no change', () => {
    const t1 = new Date(NOW.getTime() - 600_000)
    const t2 = new Date(NOW.getTime() - 300_000)
    reads = [board([issue(5, { status: 'Backlog', addedAt: at(12) })], t1), board([issue(5, { status: 'In Progress', addedAt: at(12) })], t2), board([issue(5, { status: 'In Progress', addedAt: at(12) })], NOW)]
    refreshSnapshot(p, config, t1, source)
    refreshSnapshot(p, config, t2, source)
    refreshSnapshot(p, config, NOW, source)
    assert.deepEqual(readEvents(p.activityLog).map((one) => one.kind), ['itemAdded', 'statusChanged'])
  })

  it('does not fail the refresh when the log cannot be written', () => {
    reads = [board([issue(5, { addedAt: at(12) })])]
    const broken = paths(mkdtempSync(join(tmpdir(), 'scrum-board-events-broken-')))
    mkdirSync(join(broken.dir, 'cache'), { recursive: true })
    mkdirSync(broken.activityLog)
    assert.equal(refreshSnapshot(broken, config, NOW, source)?.items.length, 1)
  })
})

describe('reading what the board events need from GitHub', () => {
  const withActivity = { ...config, runtime: { activity: true } }

  it('asks for the time an item was added, and for a pull request its opening, merging, and the issues it closes', () => {
    const selection = itemNodeSelection(config)
    assert.match(selection, /id type createdAt/)
    assert.match(selection, /on PullRequest\{.*createdAt mergedAt closingIssuesReferences\(first:3\)/s)
  })

  it('asks for the parent (the epic) only when the runtime asks for activity, or dispatch or alerts are on', () => {
    assert.doesNotMatch(itemNodeSelection(config), /parent\{/)
    assert.match(itemNodeSelection(withActivity), /parent\{/)
    assert.match(itemNodeSelection({ ...config, alerts: { enabled: true } as never }), /parent\{/)
  })

  it('keeps the times and the closed issue on the item', () => {
    const node = (type: string, content: object, createdAt = '2026-11-24T10:00:00Z') => ({ id: `PVTI_${type}`, type, createdAt, status: null, content: { number: 7, title: 't', state: 'OPEN', author: { login: 'a' }, repository: { nameWithOwner: REPO }, ...content } })
    const pages = JSON.stringify([{ data: { node: { items: { totalCount: 2, nodes: [node('ISSUE', {}), node('PULL_REQUEST', { createdAt: '2026-11-24T09:00:00Z', mergedAt: '2026-11-24T09:30:00Z', closingIssuesReferences: { nodes: [{ number: 3, repository: { nameWithOwner: REPO } }] } })] } } } }])
    const [issueItem, prItem] = parseItemPages(pages)
    assert.deepEqual([issueItem?.addedAt, issueItem?.openedAt, issueItem?.closes], ['2026-11-24T10:00:00Z', undefined, undefined])
    assert.deepEqual([prItem?.openedAt, prItem?.mergedAt, prItem?.closes], ['2026-11-24T09:00:00Z', '2026-11-24T09:30:00Z', 'app#3'])
  })

  it('reads runtime.activity as a switch, and ignores a section where it is not one', () => {
    assert.equal(parseRuntime({ activity: true })?.activity, true)
    assert.equal(parseRuntime({ activity: 'yes' }), undefined)
  })
})
