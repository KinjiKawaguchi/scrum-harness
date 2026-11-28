import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setItemPriority } from '../src/adapters/github/team-writer.ts'
import { runRuntime, type RuntimeDeps } from '../src/agency-runtime/handle.ts'
import { parseRuntimeRequest } from '../src/agency-runtime/request.ts'
import type { Tickets } from '../src/agency-runtime/types.ts'
import type { Priority } from '../src/board/priority.ts'
import { loadSnapshot, saveSnapshot } from '../src/board/snapshot.ts'
import type { BoardItem } from '../src/board/types.ts'
import type { Config } from '../src/config.ts'
import type { BoardSource } from '../src/ports/index.ts'
import { paths } from '../src/store.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, issue, NOW, snapshot } from './helpers.ts'

const config: Config = { ...base, team: { field: 'Team', value: 'Harness', adoptsUnassigned: false } }
const own = (number: number, overrides: Partial<BoardItem> = {}): BoardItem => issue(number, { team: 'Harness', ...overrides })
const other = (number: number, overrides: Partial<BoardItem> = {}): BoardItem => issue(number, { team: 'Web', ...overrides })
const request = (extra: object = {}) => ({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'prioritize', target: 'app#2', priority: 'high', by: 'alice', byParticipant: 'owner', ...extra })

describe('the prioritize request', () => {
  const parse = (extra: object) => parseRuntimeRequest(JSON.stringify(request(extra)))
  it('takes a target, a priority or none, who decided, and the decider\'s name', () => {
    assert.deepEqual(parse({}), { runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'prioritize', target: 'app#2', priority: 'high', by: 'alice', byParticipant: 'owner' })
    assert.equal((parse({ priority: 'none', byParticipant: undefined }) as { priority: string }).priority, 'none')
  })

  it('refuses what does not fit as a 400', () => {
    for (const extra of [{ target: '' }, { target: 'a b' }, { target: 'x'.repeat(121) }, { target: 'café' }, { priority: 'urgent' }, { priority: 3 }, { by: 'Not An Id' }, { byParticipant: '' }]) {
      assert.equal((parse(extra) as { status?: number }).status, 400, JSON.stringify(extra))
    }
  })
})

describe('the board\'s Priority field written with gh', () => {
  const calls: string[][] = []
  const field = (options: readonly string[]) => (args: readonly string[]): string => {
    calls.push([...args])
    return JSON.stringify({ data: { node: { field: { id: 'F_prio', options: options.map((name) => ({ id: `O_${name}`, name })) } } } })
  }
  beforeEach(() => { calls.length = 0 })
  const edit = () => calls.find((call) => call[1] === 'item-edit') ?? []

  it('sets the option of that name, in any case, and clears the field for none', () => {
    setItemPriority(field(['Highest', 'High', 'Medium', 'Low', 'Deferred']), config, issue(4), 'high')
    assert.deepEqual(edit().slice(edit().indexOf('--field-id')), ['--field-id', 'F_prio', '--single-select-option-id', 'O_High'])
    calls.length = 0
    setItemPriority(field(['Highest']), config, issue(4), null)
    assert.equal(edit().includes('--clear'), true)
    assert.equal(edit().includes('--single-select-option-id'), false)
  })

  it('names the options when the board has none of that name, and when it has no such field', () => {
    assert.throws(() => setItemPriority(field(['Highest', 'High']), config, issue(4), 'low'), /"low" is not an option of the board's "Priority" field \(Highest, High\)/)
    assert.throws(() => setItemPriority(() => JSON.stringify({ data: { node: { field: null } } }), config, issue(4), 'low'), /no single-select field "Priority"/)
    const named = { ...config, fields: { ...config.fields, priority: 'Urgency' } }
    assert.throws(() => setItemPriority(field(['High']), named, issue(4), 'low'), /"Urgency" field/)
  })
})

describe('the prioritize op', () => {
  let shared: string
  let p: ReturnType<typeof paths>
  const written: [number | null, Priority | null][] = []
  const source: BoardSource = { fetchSnapshot: () => { throw new Error('not read') }, statusEvents: () => new Map(), shared: { key: 'k1', readWhole: () => { throw new Error('not read') }, scope: () => { throw new Error('not read') } } }
  const deps = (options: { setPriority?: boolean; fail?: boolean } = {}): RuntimeDeps => {
    const ports = fakePorts({ board: source })
    const setPriority = (item: BoardItem, priority: Priority | null) => {
      if (options.fail === true) throw new Error('the board refused')
      written.push([item.number, priority])
    }
    return { p, config, now: NOW, ports: { ...ports, writer: { ...ports.writer, ...(options.setPriority === false ? {} : { setPriority }) } }, spawnRefresh: () => undefined, spawnUsageIndex: () => undefined }
  }
  const run = (extra: object = {}, options: { setPriority?: boolean; fail?: boolean } = {}) => {
    const output = runRuntime(JSON.stringify(request(extra)), deps(options))
    return { exitCode: output.exitCode, body: JSON.parse(output.stdout) as { result?: object; error?: { status: number; message: string } } }
  }
  const tickets = (): Tickets => (JSON.parse(runRuntime(JSON.stringify({ ...request(), op: 'tickets' }), deps()).stdout) as { result: Tickets }).result
  const items = [own(1, { priority: 'high' }), own(2, { epic: 'app#1' }), other(3, { epic: 'app#1' }), other(4), own(5, { priority: 'low' })]
  const writeCopy = () => {
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, 'board-k1.json'), JSON.stringify({ version: 1, key: 'k1', fetchedAt: NOW.toISOString(), board: { items, openIssues: [] } }))
  }
  beforeEach(() => {
    shared = mkdtempSync(join(tmpdir(), 'scrum-prioritize-shared-'))
    process.env.SCRUM_SHARED_DIR = shared
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-prioritize-')))
    written.length = 0
    writeCopy()
    saveSnapshot(p, snapshot(items.filter((item) => item.team === 'Harness')))
  })

  it('is listed by describe, and gives prioritizeWith, only when the board can take a priority', () => {
    const described = (options: object) => (JSON.parse(runRuntime(JSON.stringify({ ...request(), op: 'describe' }), deps(options)).stdout) as { result: { ops: string[] } }).result.ops.includes('prioritize')
    assert.deepEqual([described({}), described({ setPriority: false })], [true, false])
    const withIt = tickets()
    assert.deepEqual(withIt.epics[0]?.children.map((child) => child.prioritizeWith), ['app#2', 'app#3'])
    assert.deepEqual([withIt.epics[0]?.prioritizeWith, withIt.withoutEpic[0]?.prioritizeWith], ['app#1', 'app#5'])
  })

  it('writes the priority of a ticket the team lists, of any team, and answers {}', () => {
    assert.deepEqual(run({ target: 'app#2', priority: 'highest' }).body, { result: {} })
    assert.deepEqual(run({ target: 'app#3', priority: 'medium' }).body, { result: {} })
    assert.deepEqual(run({ target: 'app#5', priority: 'none' }).body, { result: {} })
    assert.deepEqual(written, [[2, 'highest'], [3, 'medium'], [5, null]])
  })

  it('shows the new value at once in the next tickets answer, and in the dispatch\'s board copy, with the epic\'s children taking an epic\'s', () => {
    run({ target: 'app#1', priority: 'low' })
    run({ target: 'app#2', priority: 'highest' })
    const answer = tickets()
    assert.deepEqual([answer.epics[0]?.priority, answer.epics[0]?.children.map((child) => [child.ref, child.priority, child.effectivePriority])], ['low', [['app#2', 'highest', 'highest'], ['app#3', undefined, 'low']]])
    assert.equal(loadSnapshot(p)?.items.find((item) => item.number === 2)?.priority, 'highest')
    assert.equal((JSON.parse(readFileSync(join(shared, 'board-k1.json'), 'utf8')) as { board: { items: BoardItem[] } }).board.items.find((item) => item.number === 1)?.priority, 'low')
  })

  it('writes nothing when the ticket already has that priority, and says it was done', () => {
    assert.deepEqual(run({ target: 'app#5', priority: 'low' }).body, { result: {} })
    assert.deepEqual(run({ target: 'app#2', priority: 'none' }).body, { result: {} })
    assert.deepEqual(written, [])
  })

  it('refuses, as an unknown ticket, a ticket the team does not list, a reference it made up, and a decider who is not the owner', () => {
    for (const extra of [{ target: 'app#4' }, { target: 'app#99' }, { byParticipant: 'SWE1' }]) {
      const { exitCode, body } = run(extra)
      assert.deepEqual([exitCode, body.error?.status], [1, 404], JSON.stringify(extra))
    }
    assert.deepEqual(written, [])
  })

  it('answers 503, which the node retries, when the board cannot take it, cannot be written now, or has not been read', () => {
    assert.equal(run({}, { setPriority: false }).body.error?.status, 503)
    const failed = run({}, { fail: true }).body.error
    assert.deepEqual([failed?.status, failed?.message], [503, 'could not set the priority: the board refused'])
    process.env.SCRUM_SHARED_DIR = mkdtempSync(join(tmpdir(), 'scrum-prioritize-empty-'))
    assert.equal(run({}).body.error?.status, 503)
  })
})
