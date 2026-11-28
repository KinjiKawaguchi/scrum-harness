import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { costOfPages, itemsQuery, parseItemPages, shareKey } from '../src/adapters/github/project-board.ts'
import { describeCost, lintGraphqlAllowance } from '../src/board/allowance.ts'
import { loadSnapshot, refreshSnapshot } from '../src/board/snapshot.ts'
import { obtainBoard, pruneSharedCopies, readCostRecord, sharedDir, type CostRecord } from '../src/board/shared.ts'
import type { BoardItem, Snapshot } from '../src/board/types.ts'
import type { Config } from '../src/config.ts'
import { lintAll } from '../src/findings/lint.ts'
import type { BoardSource, GraphqlCost, WholeBoard } from '../src/ports/index.ts'
import { paths, type Paths } from '../src/store.ts'
import { config as base, issue, NOW } from './helpers.ts'

const TEAMS = ['agency', 'seal', 'atlas', 'keel', 'loom'] as const
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000)
const COST: GraphqlCost = { cost: 187, remaining: 3231, limit: 5000, resetAt: '2026-10-08T06:38:00.000Z' }

/** A board source for one team: the whole board is read by `reads` (counted), and the team's items are the ones that carry its name. */
function source(team: string, reads: { count: number }, options: { key?: string; cost?: GraphqlCost; fetchOnItsOwn?: () => Snapshot } = {}): BoardSource {
  const whole = (): WholeBoard => ({
    items: TEAMS.flatMap((name, i) => [{ ...issue(i * 10 + 1), team: name }, { ...issue(i * 10 + 2), team: name }]),
    openIssues: [],
    ...(options.cost === undefined ? {} : { cost: options.cost }),
  })
  return {
    fetchSnapshot: options.fetchOnItsOwn ?? (() => { throw new Error('the team read the board on its own') }),
    statusEvents: () => new Map(),
    shared: {
      key: options.key ?? 'board-1',
      readWhole: () => (reads.count += 1, whole()),
      scope: (board, now): Snapshot => ({ fetchedAt: now.toISOString(), items: board.items.filter((item) => item.team === team), openIssues: [] }),
    },
  }
}

describe('teams that read the same board', () => {
  let shared: string
  let teams: Record<string, Paths>
  beforeEach(() => {
    shared = mkdtempSync(join(tmpdir(), 'scrum-shared-'))
    process.env.SCRUM_SHARED_DIR = shared
    teams = Object.fromEntries(TEAMS.map((name) => [name, paths(mkdtempSync(join(tmpdir(), `scrum-team-${name}-`)))]))
  })

  const cycle = (reads: { count: number }, when: Date, cost: GraphqlCost | undefined = COST) => TEAMS.map((name) => refreshSnapshot(teams[name] as Paths, base, when, source(name, reads, { ...(cost === undefined ? {} : { cost }) })))

  it('make one board read in one refresh cycle, not five, and each team gets its own items from it', () => {
    const reads = { count: 0 }
    const snapshots = cycle(reads, NOW)
    assert.equal(reads.count, 1)
    assert.deepEqual(snapshots.map((snapshot) => snapshot?.items.map((item) => item.number)), [[1, 2], [11, 12], [21, 22], [31, 32], [41, 42]])
    assert.equal(loadSnapshot(teams.seal as Paths)?.items.every((item) => item.team === 'seal'), true)
  })

  it('give each team the time the board was read, not the time it looked, so its age is honest', () => {
    const reads = { count: 0 }
    cycle(reads, NOW)
    const later = refreshSnapshot(teams.loom as Paths, base, at(120), source('loom', reads))
    assert.equal(reads.count, 1)
    assert.equal(later?.fetchedAt, NOW.toISOString())
  })

  it('read again, once, when the shared copy is older than refreshSeconds', () => {
    const reads = { count: 0 }
    cycle(reads, NOW)
    cycle(reads, at(base.refreshSeconds + 1))
    assert.equal(reads.count, 2)
    cycle(reads, at(base.refreshSeconds + 30))
    assert.equal(reads.count, 2)
  })

  it('do not share with a team whose read is not the same (another key), and keep a copy for each key', () => {
    const reads = { count: 0 }
    refreshSnapshot(teams.agency as Paths, base, NOW, source('agency', reads))
    refreshSnapshot(teams.seal as Paths, base, NOW, source('seal', reads, { key: 'board-2' }))
    assert.equal(reads.count, 2)
    assert.deepEqual(readdirSync(shared).filter((name) => name.endsWith('.json')).toSorted(), ['board-board-1.json', 'board-board-2.json'])
  })

  it('read the board on their own when sharing is off, and when the source cannot be shared', () => {
    const reads = { count: 0 }
    const own = (): Snapshot => ({ fetchedAt: NOW.toISOString(), items: [issue(9)], openIssues: [] })
    const p = teams.agency as Paths
    const off = obtainBoard(p, base, NOW, source('agency', reads, { fetchOnItsOwn: own }), null)
    assert.deepEqual([off.via, off.snapshot.items.length, reads.count], ['private', 1, 0])
    const plain: BoardSource = { fetchSnapshot: own, statusEvents: () => new Map() }
    assert.equal(obtainBoard(p, base, NOW, plain, shared).via, 'private')
  })

  it('take the copy there is while another team is reading, however old, and read on their own only when there is none', () => {
    const reads = { count: 0 }
    cycle(reads, NOW)
    // another process is reading now: the lock names a live process that is not this one
    writeFileSync(join(shared, 'board-board-1.json.lock'), String(process.ppid))
    const waiting = obtainBoard(teams.loom as Paths, base, at(600), source('loom', reads), shared)
    assert.deepEqual([waiting.via, waiting.boardAt, reads.count], ['shared', NOW.toISOString(), 1])
    const fresh = mkdtempSync(join(tmpdir(), 'scrum-shared-fresh-'))
    writeFileSync(join(fresh, 'board-board-1.json.lock'), String(process.ppid))
    const own = (): Snapshot => ({ fetchedAt: at(600).toISOString(), items: [], openIssues: [] })
    assert.equal(obtainBoard(teams.loom as Paths, base, at(600), source('loom', reads, { fetchOnItsOwn: own }), fresh).via, 'private')
    assert.equal(reads.count, 1)
  })

  it('release the lock when the read fails, so the next refresh can read', () => {
    const reads = { count: 0 }
    const failing: BoardSource = { ...source('loom', reads), shared: { ...(source('loom', reads).shared as NonNullable<BoardSource['shared']>), readWhole: () => { throw new Error('gh failed') } } }
    assert.throws(() => obtainBoard(teams.loom as Paths, base, NOW, failing, shared), /gh failed/)
    assert.equal(obtainBoard(teams.loom as Paths, base, NOW, source('loom', reads), shared).via, 'fetched')
  })

  it('ignore a copy that is damaged, or is another board\'s, and read again', () => {
    const reads = { count: 0 }
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, 'board-board-1.json'), '{"version":1,"key":"board-1","fetchedAt":"not a time","board":{"items":[],"openIssues":[]}}')
    assert.equal(obtainBoard(teams.agency as Paths, base, NOW, source('agency', reads), shared).via, 'fetched')
    writeFileSync(join(shared, 'board-board-1.json'), '{"version":1,"key":"other","fetchedAt":"2026-10-08T06:00:00.000Z","board":{"items":[],"openIssues":[]}}')
    assert.equal(obtainBoard(teams.seal as Paths, base, at(5), source('seal', reads), shared).via, 'fetched')
    assert.equal(reads.count, 2)
  })

  it('say how the board was got and what it cost: read by this team, or shared', () => {
    const reads = { count: 0 }
    cycle(reads, NOW)
    const first = readCostRecord((teams.agency as Paths).graphqlCost)
    const second = readCostRecord((teams.seal as Paths).graphqlCost)
    assert.deepEqual([first?.via, second?.via, first?.cost, second?.cost], ['fetched', 'shared', COST, COST])
    assert.equal(describeCost(first, NOW), 'board read: 187 GraphQL points (3231 of 5000 GraphQL points left, they reset at 06:38 UTC)')
    assert.equal(describeCost(second, at(75)), 'board copy shared with the other teams (read 75 seconds ago, 187 points then, 3231 of 5000 GraphQL points left, they reset at 06:38 UTC)')
    assert.equal(describeCost(null, NOW), '')
    assert.equal(describeCost({ at: NOW.toISOString(), via: 'private', boardAt: NOW.toISOString() }, NOW), '')
    assert.equal(describeCost({ at: NOW.toISOString(), via: 'fetched', boardAt: NOW.toISOString() }, NOW), 'board read: the cost is not known')
  })
})

describe('where the copies are kept', () => {
  it('is a directory for the user, set by SCRUM_SHARED_DIR, and off with "off"', () => {
    assert.match(sharedDir({}) ?? '', /\.claude\/scrum-shared$/)
    assert.equal(sharedDir({ NODE_TEST_CONTEXT: 'child-v8' }), null)
    assert.equal(sharedDir({ NODE_TEST_CONTEXT: 'child-v8', SCRUM_SHARED_DIR: '/data/shared' }), '/data/shared')
    assert.equal(sharedDir({ SCRUM_SHARED_DIR: '/data/shared' }), '/data/shared')
    assert.equal(sharedDir({ SCRUM_SHARED_DIR: 'off' }), null)
    assert.match(sharedDir({ SCRUM_SHARED_DIR: '' }) ?? '', /scrum-shared$/)
  })
})

describe('what makes two teams read the same board', () => {
  const team = (value: string): Config => ({ ...base, team: { field: 'Team', value, adoptsUnassigned: false } })

  it('is the host, the board, what is asked of each item, the repositories, and the off-board scope, and not the team', () => {
    assert.equal(shareKey(team('Seal')), shareKey(team('Atlas')))
    assert.equal(shareKey({ ...base, repos: ['example-org/app-mobile', 'example-org/app'] }), shareKey(base))
    for (const other of [{ ...base, projectId: 'PVT_other' }, { ...base, host: 'ghe.example.test' }, { ...base, repos: ['example-org/app'] }, { ...base, fields: { ...base.fields, workType: 'Work type' } }, { ...base, offBoard: { scope: 'none' as const } }]) {
      assert.notEqual(shareKey(other as Config), shareKey(base))
    }
  })
})

describe('the cost of reading the board', () => {
  const page = (cost: number, remaining: number) => ({ data: { rateLimit: { cost, remaining, limit: 5000, resetAt: '2026-10-08T06:38:00Z' }, node: { items: { totalCount: 1, nodes: [] } } } })

  it('is the points of every page added up, and what was left after the last', () => {
    assert.deepEqual(costOfPages(JSON.stringify([page(2, 4900), page(3, 4897), page(2, 4895)])), { cost: 7, remaining: 4895, limit: 5000, resetAt: '2026-10-08T06:38:00Z' })
  })

  it('is nothing when the pages do not say, or are not pages', () => {
    assert.equal(costOfPages(JSON.stringify([{ data: { node: {} } }])), undefined)
    assert.equal(costOfPages('not json'), undefined)
    assert.equal(costOfPages(JSON.stringify([{ data: { rateLimit: { cost: 1 } } }])), undefined)
  })

  it('is asked for in the query that reads the items, and does not disturb reading them', () => {
    assert.match(itemsQuery(base), /^query\(\$projectId:ID!, \$endCursor:String\)\{ rateLimit\{ cost remaining limit resetAt \} node\(id:\$projectId\)/)
    const items = [issue(1)] as readonly BoardItem[]
    const node = { id: 'PVTI_1', type: 'ISSUE', createdAt: '2026-10-08T00:00:00Z', status: null, content: { number: 1, title: items[0]?.title, state: 'OPEN', author: { login: 'a' }, repository: { nameWithOwner: 'example-org/app' } } }
    const withLimit = JSON.stringify([{ data: { ...page(2, 4900).data, node: { items: { totalCount: 1, nodes: [node] } } } }])
    assert.equal(parseItemPages(withLimit).length, 1)
  })
})

describe('the warning that the allowance is low', () => {
  const record = (cost: GraphqlCost, boardAt: Date = NOW): CostRecord => ({ at: boardAt.toISOString(), via: 'fetched', boardAt: boardAt.toISOString(), cost })

  it('is a medium finding when less than a fifth is left, with the time it resets in its key, and nothing otherwise', () => {
    const [finding] = lintGraphqlAllowance(record({ ...COST, remaining: 812 }), NOW)
    assert.deepEqual([finding?.rule, finding?.severity, finding?.key], ['B-GRAPHQL-LOW', 'medium', `B-GRAPHQL-LOW:github:${COST.resetAt}`])
    assert.match(finding?.message ?? '', /^Only 812 of 5000 GraphQL points are left this hour \(they reset at 06:38 UTC, as of the board read at 06:00 UTC\)/)
    assert.deepEqual(lintGraphqlAllowance(record({ ...COST, remaining: 1000 }), NOW), [])
    assert.equal(lintGraphqlAllowance(record({ ...COST, remaining: 999 }), NOW).length, 1)
  })

  it('is not shown after the allowance has reset, for a reading that is an hour old, or when the cost is not known', () => {
    const low = { ...COST, remaining: 10 }
    assert.deepEqual(lintGraphqlAllowance(record(low), at(40 * 60)), [])
    assert.deepEqual(lintGraphqlAllowance(record({ ...low, resetAt: '2026-10-08T09:00:00.000Z' }), at(61 * 60)), [])
    assert.deepEqual(lintGraphqlAllowance({ at: NOW.toISOString(), via: 'private', boardAt: NOW.toISOString() }, NOW), [])
    assert.deepEqual(lintGraphqlAllowance(null, NOW), [])
  })

  it('reaches the lead through lintAll', () => {
    const result = lintAll({ snapshot: null, members: [], acks: [], config: base, now: NOW, graphqlCost: record({ ...COST, remaining: 50 }) })
    assert.equal(result.active.some((one) => one.rule === 'B-GRAPHQL-LOW'), true)
  })
})

describe('the shared copies of boards that are not read any more', () => {
  const touch = (directory: string, name: string, hoursAgo: number) => {
    const path = join(directory, name)
    writeFileSync(path, '{}')
    const time = new Date(Date.now() - hoursAgo * 3_600_000)
    utimesSync(path, time, time)
  }

  it('are removed after a day without a write, and a copy that is current, and what is not a board copy, stay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'scrum-prune-'))
    touch(directory, 'board-aaaa0000.json', 30)
    touch(directory, 'board-bbbb1111.json', 2)
    touch(directory, 'graphql-use.jsonl', 30)
    touch(directory, 'notes.json', 30)
    pruneSharedCopies(directory, new Date())
    assert.deepEqual(readdirSync(directory).toSorted(), ['board-bbbb1111.json', 'graphql-use.jsonl', 'notes.json'])
  })

  it('go when a team reads the board again, and the read does not fail for a missing directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'scrum-prune-'))
    touch(directory, 'board-old00000.json', 48)
    const reads = { count: 0 }
    obtainBoard(paths(mkdtempSync(join(tmpdir(), 'scrum-prune-team-'))), base, new Date(), source('agency', reads), directory)
    assert.equal(readdirSync(directory).some((name) => name === 'board-old00000.json'), false)
    assert.doesNotThrow(() => pruneSharedCopies(join(directory, 'missing'), NOW))
  })
})
