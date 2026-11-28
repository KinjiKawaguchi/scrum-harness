import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRuntime, type RuntimeDeps } from '../src/agency-runtime/handle.ts'
import { MOST_EPICS, MOST_PULL_REQUESTS, MOST_TEXT, MOST_TICKETS, ticketsOf } from '../src/agency-runtime/tickets.ts'
import type { Tickets } from '../src/agency-runtime/types.ts'
import { effectivePriority, itemsByRef, parsePriority, priorityRank } from '../src/board/priority.ts'
import { chooseNext } from '../src/dispatch/choose.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { parseItemPages } from '../src/adapters/github/project-board.ts'
import { paths } from '../src/store.ts'
import type { BoardItem } from '../src/board/types.ts'
import type { Config } from '../src/config.ts'
import type { BoardSource } from '../src/ports/index.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, issue, NOW, pr, snapshot } from './helpers.ts'

const team = { field: 'Team', value: 'Harness', adoptsUnassigned: false }
const config: Config = { ...base, team }
const own = (number: number, overrides: Partial<BoardItem> = {}): BoardItem => issue(number, { team: 'Harness', ...overrides })
const other = (number: number, overrides: Partial<BoardItem> = {}): BoardItem => issue(number, { team: 'Web', ...overrides })
const answer = (items: readonly BoardItem[], cfg: Config = config): Tickets => {
  const result = ticketsOf(items, cfg, 'acme', 'app', NOW.toISOString())
  if ('status' in result) throw new Error(result.message)
  return result
}

describe('the priority an item is ordered by', () => {
  it('reads the board\'s option as one of the five words, in any case, and nothing else', () => {
    assert.deepEqual(['Highest', ' high ', 'MEDIUM', 'low', 'Deferred', 'urgent', '', null, undefined].map(parsePriority), ['highest', 'high', 'medium', 'low', 'deferred', null, null, null, null])
  })

  it('is its own, else its epic\'s, and none when neither has one or the epic is not on the board', () => {
    const items = [issue(1, { priority: 'high' }), issue(2, { epic: 'app#1' }), issue(3, { epic: 'app#1', priority: 'low' }), issue(4, { epic: 'app#99' }), issue(5, { epic: 'app#1', priority: null })]
    const itemOf = itemsByRef(items)
    assert.deepEqual(items.map((item) => effectivePriority(item, itemOf)), ['high', 'high', 'low', null, 'high'])
  })

  it('puts none after low, and deferred is last of all', () => {
    assert.deepEqual([null, 'highest', 'deferred', 'low', 'medium', 'high'].map((one) => priorityRank(one as never)).toSorted((a, b) => a - b), [0, 1, 2, 3, 4, 4])
    assert.equal(priorityRank(null), 4)
  })
})

describe('the dispatch with priorities', () => {
  const dispatch = { ...config, dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], orderField: 'Order', utcOffset: '+09:00', notes: [] } }
  const next = (number: number, overrides: Partial<BoardItem> = {}) => own(number, { status: 'Next', ...overrides })
  const picked = (items: readonly BoardItem[]) => {
    const result = chooseNext(snapshot(items), 'SWE1', dispatch)
    return result.kind === 'chosen' ? result.item.number : result.reason
  }

  it('hands out the higher priority first, whatever the board\'s order and the numbers say', () => {
    assert.equal(picked([next(1, { priority: 'low', order: 1 }), next(2, { priority: 'highest', order: 9 }), next(3, { priority: 'high', order: 1 })]), 2)
  })

  it('takes the epic\'s priority for a child with none, and puts work with no priority after low', () => {
    assert.equal(picked([own(10, { priority: 'high' }), next(1), next(2, { epic: 'app#10' }), next(3, { priority: 'low' })]), 2)
    assert.equal(picked([next(1), next(2, { priority: 'low' })]), 2)
  })

  it('does not hand out deferred work, nor a child of a deferred epic that has no priority of its own', () => {
    assert.equal(picked([next(1, { priority: 'deferred' })]), 'no-candidate')
    assert.equal(picked([own(10, { priority: 'deferred' }), next(2, { epic: 'app#10' }), next(3)]), 3)
  })

  it('does not hand out work with no priority when the team says to skip it, and still hands out what has one, its own or its epic\'s', () => {
    const skip = { ...dispatch, dispatch: { ...dispatch.dispatch, unprioritized: 'skip' as const } }
    const pick = (items: readonly BoardItem[], cfg: Config) => {
      const result = chooseNext(snapshot(items), 'SWE1', cfg)
      return result.kind === 'chosen' ? result.item.number : result.reason
    }
    assert.equal(pick([next(1), next(2)], skip), 'no-candidate')
    assert.equal(pick([next(1), next(2, { priority: 'low' })], skip), 2)
    assert.equal(pick([own(10, { priority: 'medium' }), next(1, { epic: 'app#10' })], skip), 1)
    assert.equal(pick([next(1), next(2)], { ...skip, dispatch: { ...skip.dispatch, unprioritized: 'last' } }), 1)
    assert.equal(pick([next(1), next(2)], dispatch), 1)
  })

  it('orders as before when the board has no priorities', () => {
    assert.equal(picked([next(5, { order: 2 }), next(6, { order: 1 })]), 6)
  })
})

describe('the board read with the priority', () => {
  it('keeps the option as a priority on the item, and leaves the key out when the read did not ask', () => {
    const node = (number: number, extra: object) => ({ id: `PVTI_${number}`, type: 'ISSUE', createdAt: '2026-11-24T10:00:00Z', status: null, content: { number, title: 't', state: 'OPEN', author: { login: 'a' }, repository: { nameWithOwner: 'example-org/app' } }, ...extra })
    const pages = JSON.stringify([{ data: { node: { items: { totalCount: 4, nodes: [node(1, { priority: { name: 'High' } }), node(2, { priority: null }), node(3, { priority: { name: 'Urgent' } }), node(4, {})] } } } }])
    assert.deepEqual(parseItemPages(pages).map((item) => item.priority), ['high', null, null, undefined])
  })
})

describe('the tickets of a team', () => {
  it('lists the epics the team owns with every child, whatever the child\'s team, open or closed, and the team\'s tickets in no epic', () => {
    const answerOf = answer([
      own(1, { title: 'Persistent sessions', priority: 'high' }),
      own(2, { epic: 'app#1', status: 'In Progress', assignee: 'SWE1', points: 3 }),
      other(3, { epic: 'app#1', status: 'Done', state: 'CLOSED' }),
      own(4, { epic: 'app#1', priority: 'low' }),
      own(5),
      other(6),
      other(7, { title: 'An epic of Web' }),
      other(8, { epic: 'app#7' }),
      own(9, { epic: 'app#7' }),
    ])
    assert.deepEqual(answerOf.epics.map((epic) => [epic.ref, epic.children.map((child) => child.ref)]), [['app#1', ['app#2', 'app#3', 'app#4']]])
    assert.deepEqual(answerOf.withoutEpic.map((ticket) => ticket.ref), ['app#5'])
    assert.deepEqual([answerOf.org, answerOf.team, answerOf.generatedAt], ['acme', 'app', NOW.toISOString()])
  })

  it('says per ticket what the board says: status (closed is done, an unknown one is backlog), team, assignee, points, and both priorities', () => {
    const [epic] = answer([own(1, { priority: 'high' }), own(2, { epic: 'app#1', status: 'In Progress', assignee: 'SWE1', points: 3 }), other(3, { epic: 'app#1', status: 'Done', state: 'CLOSED', priority: 'low' }), own(4, { epic: 'app#1', status: 'Triage', points: 2.5 })]).epics
    assert.deepEqual(epic?.children.map((child) => ({ ...child })), [
      { ref: 'app#2', title: 'issue 2', status: 'inProgress', team: 'Harness', assignee: 'SWE1', points: 3, effectivePriority: 'high', pullRequests: [] },
      { ref: 'app#3', title: 'issue 3', status: 'done', team: 'Web', priority: 'low', effectivePriority: 'low', pullRequests: [] },
      { ref: 'app#4', title: 'issue 4', status: 'backlog', team: 'Harness', effectivePriority: 'high', pullRequests: [] },
    ].toSorted((a, b) => ['high', 'low'].indexOf(a.effectivePriority) - ['high', 'low'].indexOf(b.effectivePriority) || a.ref.localeCompare(b.ref)))
    assert.deepEqual([epic?.ref, epic?.priority, epic?.effectivePriority], ['app#1', 'high', 'high'])
  })

  it('orders epics and tickets by their effective priority, then by reference, and an epic of another team\'s child by its own', () => {
    const result = answer([own(10, { priority: 'low' }), own(11, { priority: 'highest' }), own(12), own(13, { priority: 'high' }), own(2, { priority: 'high' })])
    assert.deepEqual(result.withoutEpic.map((ticket) => ticket.ref), ['app#11', 'app#2', 'app#13', 'app#10', 'app#12'])
  })

  it('names a ticket\'s open pull requests, by the issue each closes, and not a merged or closed one', () => {
    const result = answer([own(1), pr(20, { state: 'OPEN', closes: 'app#1', title: 'Fix it', repo: 'example-org/app' }), pr(21, { state: 'MERGED', closes: 'app#1' }), pr(22, { state: 'OPEN', closes: 'app#1', repo: 'example-org/app-mobile' }), pr(23, { state: 'OPEN' })])
    assert.deepEqual(result.withoutEpic[0]?.pullRequests, [{ repo: 'example-org/app', number: 20, title: 'Fix it' }, { repo: 'example-org/app-mobile', number: 22, title: 'issue 22' }])
  })

  it('puts a ticket whose parent is not on the board among the tickets with no epic, and follows a chain of parents to the epic at the top', () => {
    const result = answer([own(1, { epic: 'app#99' }), own(2), own(3, { epic: 'app#2' }), own(4, { epic: 'app#3' })])
    assert.deepEqual(result.withoutEpic.map((ticket) => ticket.ref), ['app#1'])
    assert.deepEqual(result.epics.map((epic) => [epic.ref, epic.children.map((child) => child.ref)]), [['app#2', ['app#3', 'app#4']]])
  })

  it('lists an epic that says it has sub-issues even when none of them is on the board, and a loop of parents does not hang', () => {
    assert.deepEqual(answer([own(1, { subIssues: 2 })]).epics.map((epic) => [epic.ref, epic.children.length]), [['app#1', 0]])
    assert.doesNotThrow(() => answer([own(1, { epic: 'app#2' }), own(2, { epic: 'app#1' })]))
  })

  it('leaves out pull requests, drafts and what the configuration leaves out, and answers for the whole board when the team has no scope', () => {
    const items = [issue(1, { team: null }), pr(2), issue(3, { kind: 'draft', number: null }), issue(4, { author: 'external-dev' })]
    assert.deepEqual(answer(items, base).withoutEpic.map((ticket) => ticket.ref), ['app#1'])
    assert.deepEqual(answer(items).withoutEpic, [])
    assert.deepEqual(answer([issue(5, { team: null })], { ...config, team: { ...team, adoptsUnassigned: true } }).withoutEpic.map((ticket) => ticket.ref), ['app#5'])
  })

  it('cuts text at 200 characters without splitting a character, and a pull request list at 50', () => {
    const long = `${'a'.repeat(199)}\u{1F600}${'b'.repeat(10)}`
    const result = answer([own(1, { title: long, assignee: long }), ...Array.from({ length: 60 }, (_, i) => pr(100 + i, { state: 'OPEN', closes: 'app#1' }))])
    const ticket = result.withoutEpic[0]
    assert.deepEqual([[...(ticket?.title ?? '')].length, ticket?.title.endsWith('\u{1F600}'), [...(ticket?.assignee ?? '')].length, ticket?.pullRequests.length], [MOST_TEXT, true, MOST_TEXT, MOST_PULL_REQUESTS])
  })

  it('refuses an answer beyond the limits whole', () => {
    const many = (count: number) => Array.from({ length: count }, (_, i) => own(10_000 + i))
    assert.match((ticketsOf(many(MOST_TICKETS + 1), config, 'acme', 'app', NOW.toISOString()) as { message: string }).message, /more than the 5000/)
    const epics = Array.from({ length: MOST_EPICS + 1 }, (_, i) => own(1 + i, { subIssues: 1 }))
    assert.match((ticketsOf(epics, config, 'acme', 'app', NOW.toISOString()) as { message: string }).message, /501 epics, more than the 500/)
  })
})

describe('the tickets op', () => {
  let shared: string
  let p: ReturnType<typeof paths>
  const call = (op: object = {}) => ({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'tickets', ...op })
  const source: BoardSource = {
    fetchSnapshot: () => { throw new Error('not read') },
    statusEvents: () => new Map(),
    shared: { key: 'k1', readWhole: () => { throw new Error('not read') }, scope: () => { throw new Error('not read') } },
  }
  const deps = (cfg: Config): RuntimeDeps => ({ p, config: cfg, now: NOW, ports: fakePorts({ board: source }), spawnRefresh: () => undefined, spawnUsageIndex: () => undefined })
  const run = (cfg: Config) => {
    const output = runRuntime(JSON.stringify(call()), deps(cfg))
    return { exitCode: output.exitCode, body: JSON.parse(output.stdout) as { result?: Tickets; error?: { status: number; message: string } } }
  }
  const writeCopy = (items: readonly BoardItem[], fetchedAt = NOW.toISOString()) => {
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, 'board-k1.json'), JSON.stringify({ version: 1, key: 'k1', fetchedAt, board: { items, openIssues: [] } }))
  }
  beforeEach(() => {
    shared = mkdtempSync(join(tmpdir(), 'scrum-tickets-shared-'))
    process.env.SCRUM_SHARED_DIR = shared
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-tickets-')))
  })

  it('answers from the whole board the teams of the machine share, with the time it was read', () => {
    writeCopy([own(1), other(2, { epic: 'app#1' })], '2026-10-08T05:57:30.000Z')
    const { exitCode, body } = run(config)
    assert.equal(exitCode, 0)
    assert.deepEqual([body.result?.generatedAt, body.result?.epics.map((epic) => epic.children.map((child) => child.ref))], ['2026-10-08T05:57:30.000Z', [['app#2']]])
  })

  it('says that the board is not there yet, with a refresh started, when a team of a shared board has no copy of the whole', () => {
    saveSnapshot(p, snapshot([own(1)]))
    const { exitCode, body } = run(config)
    assert.deepEqual([exitCode, body.error?.status], [1, 503])
    assert.match(body.error?.message ?? '', /whole board has not been read yet/)
  })

  it('answers a team alone on its board from its own copy', () => {
    saveSnapshot(p, snapshot([issue(1), issue(2, { epic: 'app#1' })]))
    const { exitCode, body } = run(base)
    assert.equal(exitCode, 0)
    assert.deepEqual(body.result?.epics.map((epic) => epic.ref), ['app#1'])
  })

  it('is listed by describe and is a request of its own', () => {
    const described = JSON.parse(runRuntime(JSON.stringify({ ...call(), op: 'describe' }), deps(config)).stdout) as { result: { ops: string[] } }
    assert.equal(described.result.ops.includes('tickets'), true)
  })
})
