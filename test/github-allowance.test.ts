import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { guarded, type GhRun } from '../src/adapters/github/gh.ts'
import { GithubLimited, isGraphqlCall, limitGuard, limitKindOf, pointsOf, retryAfterSeconds, whatOf } from '../src/adapters/github/limit-guard.ts'
import { readAllowance } from '../src/adapters/github/project-board.ts'
import { describeCost, describeUse, isReadHeld, lintGraphqlUse } from '../src/board/allowance.ts'
import { SMALL_QUERY_POINTS, readBackoff, readUse, recordUse, summarizeUse, useLedgerPath, type UseEntry } from '../src/board/graphql-use.ts'
import { loadSnapshot, refreshSnapshot } from '../src/board/snapshot.ts'
import { BoardReadHeld, obtainBoard } from '../src/board/shared.ts'
import type { Snapshot } from '../src/board/types.ts'
import type { BoardSource, GraphqlAllowance, WholeBoard } from '../src/ports/index.ts'
import { paths } from '../src/store.ts'
import { config as base, issue, NOW } from './helpers.ts'

const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000)
const LIMIT = 5000
const resetAt = at(1800).toISOString()
const allowance = (remaining: number): GraphqlAllowance => ({ remaining, limit: LIMIT, resetAt })

const SECONDARY = 'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)'
const PRIMARY = 'GraphQL: API rate limit already exceeded for user ID 1.'
const failing = (text: string): Error => Object.assign(new Error('Command failed'), { stderr: text, stdout: '' })

describe('which calls of gh spend GraphQL points, and what they say', () => {
  it('knows `gh api graphql` and the commands gh builds on GraphQL, and not a REST call', () => {
    assert.deepEqual([['api', 'graphql', '-f', 'query=x'], ['issue', 'list'], ['pr', 'view', '1'], ['project', 'item-list'], ['api', 'rate_limit'], ['api', 'repos/acme/app/issues'], ['auth', 'status']].map(isGraphqlCall), [true, true, true, true, false, false, false])
  })

  it('names a call by its command, or by the first field of its query', () => {
    assert.equal(whatOf(['issue', 'list', '-R', 'acme/app']), 'issue list')
    assert.equal(whatOf(['api', 'graphql', '-f', 'query=query($id:ID!){ rateLimit{ cost } node(id:$id){ id } }']), 'graphql node')
    assert.equal(whatOf(['api', 'graphql', '-f', 'query=mutation($i:ID!){ updateProjectV2ItemFieldValue(input:{}){ clientMutationId } }']), 'graphql updateProjectV2ItemFieldValue')
    assert.equal(whatOf(['api', 'graphql', '-f', 'query=query{ a0: repository(owner:"o", name:"n"){ id } }']), 'graphql repository')
    assert.equal(whatOf(['api', 'graphql']), 'graphql')
  })

  it('counts the cost the answer states, a page each, else a quarter of a point (a small query)', () => {
    assert.equal(pointsOf(JSON.stringify([{ data: { rateLimit: { cost: 1 } } }, { data: { rateLimit: { cost: 1 } } }, { data: { rateLimit: { cost: 3 } } }])), 5)
    assert.equal(pointsOf(JSON.stringify({ data: { rateLimit: { cost: 2 } } })), 2)
    assert.deepEqual([pointsOf('{"data":{}}'), pointsOf('not json'), pointsOf('')], [SMALL_QUERY_POINTS, SMALL_QUERY_POINTS, SMALL_QUERY_POINTS])
    assert.equal(SMALL_QUERY_POINTS, 0.25)
  })

  it('tells a secondary limit from the hour\'s points used up, from what gh says', () => {
    assert.equal(limitKindOf(SECONDARY), 'secondary')
    assert.equal(limitKindOf(PRIMARY), 'primary')
    assert.equal(limitKindOf('gh: Could not resolve to an Issue with the number of 999. (HTTP 200)'), null)
    assert.deepEqual([retryAfterSeconds('retry-after: 90'), retryAfterSeconds('Please try again in 30 seconds'), retryAfterSeconds(SECONDARY)], [90, 30, null])
  })
})

describe('the guard of a machine\'s calls to GitHub', () => {
  let directory: string
  let clock: Date
  let asked: string[][]
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'scrum-guard-'))
    clock = NOW
    asked = []
  })
  const guardOf = (reset: number | null = at(1800).getTime() / 1000) =>
    limitGuard({
      directory,
      team: 'app',
      now: () => clock,
      raw: (args) => {
        asked.push([...args])
        if (reset === null) throw new Error('no answer')
        return `${reset}\n`
      },
    })
  const run = (call: GhRun) => guarded(call, guardOf())
  const graphql = ['api', 'graphql', '-f', 'query=query{ node(id:"x"){ id } }']

  it('counts each GraphQL call with its team and what it asked, and leaves other calls out', () => {
    const call = run(() => JSON.stringify([{ data: { rateLimit: { cost: 4 } } }]))
    call(graphql)
    call(['api', 'repos/acme/app/issues'])
    assert.deepEqual(readUse(directory), [{ at: NOW.toISOString(), team: 'app', what: 'graphql node', points: 4 }])
  })

  it('waits a minute after a secondary limit, doubling while it goes on, and refuses GraphQL calls without asking GitHub meanwhile', () => {
    let calls = 0
    const call = run(() => {
      calls += 1
      throw failing(SECONDARY)
    })
    assert.throws(() => call(graphql), /Command failed/)
    assert.equal(readBackoff(directory)?.until, at(60).toISOString())
    clock = at(30)
    assert.throws(() => call(graphql), (error: unknown) => error instanceof GithubLimited && error.until.getTime() === at(60).getTime())
    assert.equal(calls, 1)
    clock = at(61)
    assert.throws(() => call(graphql), /Command failed/)
    assert.deepEqual([readBackoff(directory)?.streak, readBackoff(directory)?.until], [2, at(61 + 120).toISOString()])
  })

  it('waits as long as GitHub asked, up to a quarter of an hour', () => {
    assert.throws(() => run(() => { throw failing(`${SECONDARY}\nretry-after: 200`) })(graphql))
    assert.equal(readBackoff(directory)?.until, at(200).toISOString())
    clock = at(201)
    assert.throws(() => run(() => { throw failing(`${SECONDARY}\nretry-after: 5000`) })(graphql), /Command failed/)
    assert.equal(readBackoff(directory)?.until, at(201 + 900).toISOString())
  })

  it('does not hold a call that is not GraphQL, and goes on when the wait is over, which clears it', () => {
    let fail = true
    const call = run((args) => {
      if (fail && args.includes('graphql')) throw failing(SECONDARY)
      return '{}'
    })
    assert.throws(() => call(graphql))
    assert.equal(call(['api', 'rate_limit']), '{}')
    clock = at(120)
    fail = false
    assert.equal(call(graphql), '{}')
    assert.equal(readBackoff(directory), null)
  })

  it('waits for the reset of the hour\'s points when they are used up, as `rate_limit` says, and ten minutes when it cannot be asked', () => {
    assert.throws(() => run(() => { throw failing(PRIMARY) })(graphql))
    assert.deepEqual(asked, [['api', 'rate_limit', '--jq', '.resources.graphql.reset']])
    assert.equal(readBackoff(directory)?.until, at(1805).toISOString())
    directory = mkdtempSync(join(tmpdir(), 'scrum-guard-'))
    assert.throws(() => guarded(() => { throw failing(PRIMARY) }, guardOf(null))(graphql))
    assert.equal(readBackoff(directory)?.until, at(600).toISOString())
  })

  it('leaves a failure that is not a limit alone, and does nothing without a directory', () => {
    assert.throws(() => run(() => { throw failing('Could not resolve to an Issue') })(graphql), /Command failed/)
    assert.equal(readBackoff(directory), null)
    const off = guarded(() => '{}', limitGuard({ directory: null, team: 'app', raw: () => '' }))
    assert.equal(off(graphql), '{}')
  })
})

describe('the ledger of what the harness spent', () => {
  let directory: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'scrum-ledger-')) })
  const entry = (seconds: number, team: string, what: string, points: number): UseEntry => ({ at: at(seconds).toISOString(), team, what, points })

  it('adds up the last hour, by kind of call and by team, the dearest first', () => {
    const entries = [entry(-4000, 'app', 'graphql node', 500), entry(-3000, 'app', 'graphql node', 20), entry(-2000, 'web', 'graphql node', 8), entry(-100, 'web', 'issue list', 1), entry(-50, 'app', 'graphql node', 1)]
    const summary = summarizeUse(entries, NOW)
    assert.deepEqual([summary.points, summary.calls], [30, 4])
    assert.deepEqual(summary.byWhat, [{ what: 'graphql node', points: 29, calls: 3 }, { what: 'issue list', points: 1, calls: 1 }])
    assert.deepEqual(summary.byTeam, [{ team: 'app', points: 21 }, { team: 'web', points: 9 }])
  })

  it('keeps what is written, in order, and skips a line that is not an entry', () => {
    recordUse(directory, entry(-10, 'app', 'a', 1), NOW)
    writeFileSync(useLedgerPath(directory), `${readFileSync(useLedgerPath(directory), 'utf8')}not json\n{"at":1}\n`)
    recordUse(directory, entry(-5, 'app', 'b', 2), NOW)
    assert.deepEqual(readUse(directory).map((one) => one.what), ['a', 'b'])
  })

  it('drops what is older than two hours when the file has grown large', () => {
    const old = entry(-3 * 3600, 'app', 'old', 1)
    writeFileSync(useLedgerPath(directory), `${JSON.stringify(old)}\n`.repeat(4000))
    recordUse(directory, entry(-1, 'app', 'new', 1), NOW)
    assert.deepEqual(readUse(directory).map((one) => one.what), ['new'])
  })

  it('says nothing under a quarter of the limit, medium from it, and high from half of it, with what the points went on', () => {
    const spent = (points: number) => summarizeUse([entry(-10, 'app', 'graphql node', points), entry(-5, 'app', 'issue list', 3)], NOW)
    assert.deepEqual(lintGraphqlUse(spent(1000), LIMIT), [])
    const [medium] = lintGraphqlUse(spent(1300), LIMIT)
    assert.deepEqual([medium?.rule, medium?.severity], ['B-GRAPHQL-USE', 'medium'])
    assert.match(medium?.message ?? '', /about 1303 of 5000 GraphQL points in the last hour \(2 calls; most on graphql node 1300 \(1 calls\), issue list 3 \(1 calls\)\)/)
    assert.equal(lintGraphqlUse(spent(2600), LIMIT)[0]?.severity, 'high')
    assert.deepEqual(lintGraphqlUse(spent(2600), null), [])
    assert.equal(describeUse(spent(10)), 'the harness used about 13 GraphQL points in the last hour (2 calls)')
    assert.equal(describeUse(summarizeUse([], NOW)), '')
    assert.match(describeUse(summarizeUse([entry(-5, 'app', 'issue list', SMALL_QUERY_POINTS), entry(-4, 'app', 'pr list', SMALL_QUERY_POINTS), entry(-3, 'app', 'pr list', SMALL_QUERY_POINTS)], NOW)), /used about 1 GraphQL points/)
  })
})

describe('holding back a read of the board while the hour\'s points are low', () => {
  const copyAt = (secondsAgo: number): string => at(-secondsAgo).toISOString()

  it('reads as usual with more than a fifth left, or when the allowance is not known or has reset', () => {
    assert.equal(isReadHeld(allowance(1000), copyAt(3600), 300, NOW), false)
    assert.equal(isReadHeld(null, copyAt(3600), 300, NOW), false)
    assert.equal(isReadHeld({ ...allowance(10), resetAt: at(-1).toISOString() }, copyAt(3600), 300, NOW), false)
  })

  it('reads a quarter as often with less than a fifth left, and not more often than every ten minutes', () => {
    assert.equal(isReadHeld(allowance(999), copyAt(599), 100, NOW), true)
    assert.equal(isReadHeld(allowance(999), copyAt(601), 100, NOW), false)
    assert.equal(isReadHeld(allowance(999), copyAt(2399), 600, NOW), true)
    assert.equal(isReadHeld(allowance(999), copyAt(2401), 600, NOW), false)
    assert.equal(isReadHeld(allowance(999), null, 300, NOW), false)
  })

  it('does not read at all with less than a twentieth left, until the points reset', () => {
    assert.equal(isReadHeld(allowance(249), copyAt(86_400), 300, NOW), true)
    assert.equal(isReadHeld(allowance(249), null, 300, NOW), true)
    assert.equal(isReadHeld(allowance(250), copyAt(86_400), 300, NOW), false)
  })

  it('reads the allowance from `rate_limit`, and says nothing when it cannot', () => {
    const answer = JSON.stringify({ resources: { graphql: { limit: 5000, remaining: 812, reset: 1_700_000_000 } } })
    assert.deepEqual(readAllowance(() => answer), { remaining: 812, limit: 5000, resetAt: '2023-11-14T22:13:20.000Z' })
    assert.equal(readAllowance(() => '{}'), null)
    assert.equal(readAllowance(() => { throw new Error('offline') }), null)
  })

  it('says in `scrum refresh` that the board copy was kept', () => {
    const record = { at: NOW.toISOString(), via: 'held' as const, boardAt: copyAt(900), cost: { cost: 20, remaining: 700, limit: LIMIT, resetAt } }
    assert.match(describeCost(record, NOW), /held back to leave the GraphQL points to others \(700 of 5000 GraphQL points left, they reset at \d\d:\d\d UTC\); using the copy read 900 seconds ago/)
  })
})

describe('a refresh while the points are low', () => {
  let shared: string
  beforeEach(() => { shared = mkdtempSync(join(tmpdir(), 'scrum-held-')) })
  const sourceOf = (remaining: number | null, reads: { count: number }): BoardSource => ({
    fetchSnapshot: () => { throw new Error('read on its own') },
    statusEvents: () => new Map(),
    shared: {
      key: 'board-1',
      readWhole: () => (reads.count += 1, { items: [issue(1)], openIssues: [] } satisfies WholeBoard),
      allowance: () => (remaining === null ? null : allowance(remaining)),
      scope: (board, now): Snapshot => ({ fetchedAt: now.toISOString(), items: board.items, openIssues: [] }),
    },
  })
  const first = (): { p: ReturnType<typeof paths>; reads: { count: number } } => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-held-team-')))
    const reads = { count: 0 }
    process.env.SCRUM_SHARED_DIR = shared
    refreshSnapshot(p, base, NOW, sourceOf(4000, reads))
    return { p, reads }
  }

  it('keeps the copy there is, instead of a read, and the board copy says when it was read', () => {
    const { p, reads } = first()
    const later = at(base.refreshSeconds + 10)
    const snapshot = refreshSnapshot(p, base, later, sourceOf(900, reads))
    assert.deepEqual([reads.count, snapshot?.fetchedAt], [1, NOW.toISOString()])
  })

  it('reads again once the stretched wait has passed', () => {
    const { p, reads } = first()
    refreshSnapshot(p, base, at(base.refreshSeconds * 4 + 10), sourceOf(900, reads))
    assert.equal(reads.count, 2)
  })

  it('does nothing, and says no error, when almost nothing is left and there is no copy', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-held-team-')))
    process.env.SCRUM_SHARED_DIR = shared
    const reads = { count: 0 }
    assert.throws(() => obtainBoard(p, base, NOW, sourceOf(100, reads), shared), BoardReadHeld)
    assert.equal(refreshSnapshot(p, base, NOW, sourceOf(100, reads)), null)
    assert.deepEqual([reads.count, loadSnapshot(p)], [0, null])
  })

  it('holds a team that reads on its own, too, with almost nothing left', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-held-team-')))
    const reads = { count: 0 }
    assert.throws(() => obtainBoard(p, base, NOW, sourceOf(100, reads), null), BoardReadHeld)
  })
})
