import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRuntime, usageOffsetMinutes } from '../src/agency-runtime/config.ts'
import { runRuntime, type RuntimeDeps } from '../src/agency-runtime/handle.ts'
import type { TokenUsage } from '../src/agency-runtime/types.ts'
import type { Config } from '../src/config.ts'
import { EMPTY_INDEX, type CompactRow, type UsageIndex } from '../src/usage/index-store.ts'
import { writeIndexForTest } from './usage-index-file.ts'
import { paths, type Paths } from '../src/store.ts'
import { config } from './agency-runtime-board.ts'
import { fakePorts } from './fake-ports.ts'
import { NOW } from './helpers.ts'
import { assistantLine, SESSION_A, SESSION_B, SESSION_OTHER, writeTranscript } from './usage-fixtures.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const request = (extra: object = {}) => JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'tokenUsage', days: 3, ...extra })
type Response = { result?: TokenUsage; error?: { status: number; message: string } }

let p: Paths
let spawns = 0

const deps = (overrides: Partial<RuntimeDeps> = {}, withConfig: Config = config): RuntimeDeps => ({
  p,
  config: withConfig,
  now: NOW,
  ports: fakePorts({ transcripts: { files: () => [], names: () => new Map([[SESSION_A, 'TechLead'], [SESSION_B, 'SWE1'], [SESSION_OTHER, 'Liaison']]), scan: () => { throw new Error('not used') } } }),
  spawnRefresh: () => undefined,
  spawnUsageIndex: () => {
    spawns += 1
  },
  ...overrides,
})

const call = (input: string, overrides: Partial<RuntimeDeps> = {}, withConfig: Config = config) => {
  const output = runRuntime(input, deps(overrides, withConfig))
  return { exitCode: output.exitCode, response: JSON.parse(output.stdout) as Response }
}

const minute = (iso: string) => Date.parse(iso) / 60_000
/** $4 of the default model */
const row = (session: number, iso: string): CompactRow => [session, minute(iso), 0, 0, 1_000_000, 0, 0, 0, 0]
const index = (rows: readonly CompactRow[], updatedAt: Date = NOW): UsageIndex => ({ ...EMPTY_INDEX, updatedAt: updatedAt.toISOString(), sessionIds: [SESSION_A, SESSION_B, SESSION_OTHER], models: ['claude-opus-5-5'], rows })

/** The checks the node makes on a result before it serves it. */
function nodeProblem(result: TokenUsage, asked: { org: string; team: string; days: number }): string | null {
  if (result.org !== asked.org || result.team !== asked.team || result.days !== asked.days) return 'org, team, or days differ from the request'
  if (result.byDay.length > asked.days) return 'too many days'
  if (result.byDay.some((day, i) => i > 0 && day.date <= (result.byDay[i - 1]?.date ?? ''))) return 'dates are not strictly increasing'
  if (result.byDay.some((day) => !/^\d{4}-\d{2}-\d{2}$/.test(day.date))) return 'a date is malformed'
  const costs = [...result.byDay.flatMap((day) => Object.values(day.costUsd)), ...result.byPerson.map((one) => one.costUsd)]
  if (costs.some((cost) => !Number.isFinite(cost) || cost < 0)) return 'a cost is not a finite non-negative number'
  if (result.byPerson.some((one) => one.person === '' || Object.keys(one.tokens).sort().join() !== 'cacheRead,cacheWrite,input,output')) return 'a person or its tokens are malformed'
  if (result.byPerson.some((one) => Object.values(one.tokens).some((count) => !Number.isInteger(count) || count < 0))) return 'a token count is not a non-negative integer'
  return Number.isNaN(Date.parse(result.generatedAt)) ? 'generatedAt is not a time' : null
}

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-runtime-usage-')))
  spawns = 0
})

describe('tokenUsage requests', () => {
  const refused: readonly (readonly [string, object])[] = [
    ['no days', { days: undefined }],
    ['0 days', { days: 0 }],
    ['91 days', { days: 91 }],
    ['a fractional number of days', { days: 1.5 }],
    ['days given as text', { days: '3' }],
    ['a negative number of days', { days: -1 }],
  ]
  for (const [name, extra] of refused) {
    it(`answers ${name} with a 400`, () => {
      const { exitCode, response } = call(request(extra))
      assert.deepEqual([exitCode, response.error?.status], [1, 400])
    })
  }

  it('accepts the whole range from 1 to 90', () => {
    writeIndexForTest(p, index([row(1, '2026-10-08T05:00:00Z')]))
    assert.deepEqual([1, 90].map((days) => call(request({ days })).exitCode), [0, 0])
  })
})

describe('answering tokenUsage', () => {
  beforeEach(() => {
    writeIndexForTest(p, index([row(0, '2026-10-08T05:00:00Z'), row(1, '2026-10-08T05:30:00Z'), row(1, '2026-10-06T05:30:00Z'), row(2, '2026-10-08T05:00:00Z')]))
  })

  it('reports the team by day and person in the shape the node accepts', () => {
    const { exitCode, response } = call(request())
    assert.equal(exitCode, 0)
    assert.equal(nodeProblem(response.result as TokenUsage, { org: 'acme', team: 'app', days: 3 }), null)
    assert.deepEqual(response.result?.byDay, [
      { date: '2026-10-06', costUsd: { SWE1: 4 } },
      { date: '2026-10-07', costUsd: {} },
      { date: '2026-10-08', costUsd: { TechLead: 4, SWE1: 4 } },
    ])
    assert.deepEqual(response.result?.byPerson.map((one) => [one.person, one.costUsd]), [['SWE1', 8], ['TechLead', 4]])
    assert.equal(response.result?.generatedAt, NOW.toISOString())
  })

  it('counts the TechLead and the members only, not the other sessions in the index', () => {
    const people = call(request()).response.result?.byPerson.map((one) => one.person)
    assert.equal(people?.includes('Liaison'), false)
  })

  it('answers from the index without starting a read when the index is fresh', () => {
    call(request())
    assert.equal(spawns, 0)
  })

  it('answers from the old index and starts a read in the background when the index is stale', () => {
    writeIndexForTest(p, index([row(0, '2026-10-08T05:00:00Z')], new Date(NOW.getTime() - 6 * 60_000)))
    const { exitCode } = call(request())
    assert.deepEqual([exitCode, spawns], [0, 1])
  })

  it('cuts the days in the configured time zone', () => {
    writeIndexForTest(p, index([row(0, '2026-10-08T20:00:00Z')]))
    const zoned: Config = { ...config, runtime: { ...config.runtime, utcOffset: '+09:00' } }
    const { response } = call(request({ days: 1 }), { now: new Date('2026-10-08T21:00:00.000Z') }, zoned)
    assert.deepEqual(response.result?.byDay, [{ date: '2026-10-09', costUsd: { TechLead: 4 } }])
  })

  it('answers 404 when no session of the team recorded usage', () => {
    writeIndexForTest(p, index([row(2, '2026-10-08T05:00:00Z')]))
    const { exitCode, response } = call(request(), { ports: fakePorts({ transcripts: { files: () => [], names: () => new Map(), scan: () => { throw new Error('not used') } } }) })
    assert.deepEqual([exitCode, response.error?.status], [1, 404])
  })
})

describe('tokenUsage before the first read', () => {
  it('answers 503, starts the read, and does not wait for it', () => {
    const { exitCode, response } = call(request())
    assert.deepEqual([exitCode, response.error?.status, spawns], [1, 503, 1])
  })
})

describe('the time zone of the usage report', () => {
  it('uses the runtime offset, then the sprint offset, then UTC', () => {
    const sprint = { checkpoints: [], utcOffset: '+05:30', pointsField: 'P', overrunField: 'O', pointBudgets: {} }
    assert.deepEqual(
      [{ ...config, runtime: { utcOffset: '-03:00' }, sprint }, { ...config, runtime: {}, sprint }, { ...config, runtime: {}, sprint: undefined }].map(usageOffsetMinutes),
      [-180, 330, 0],
    )
  })

  it('ignores a runtime section whose offset is malformed, like any other malformed value', () => {
    assert.equal(parseRuntime({ utcOffset: '9' }), undefined)
    assert.deepEqual(parseRuntime({ utcOffset: '+09:00', label: 'App' }), { label: 'App', utcOffset: '+09:00' })
  })
})

describe('scrum runtime tokenUsage (the command)', () => {
  const env = (state: string, projects: string, sessions: string) => ({ ...process.env, SCRUM_STATE_DIR: state, SCRUM_PROJECTS_DIR: projects, SCRUM_SESSIONS_DIR: sessions })
  const run = (e: NodeJS.ProcessEnv, args: string[], input = '') => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { input, env: e, encoding: 'utf8' })

  it('reads the transcripts into the index in the background and then answers from it', async () => {
    const state = mkdtempSync(join(tmpdir(), 'scrum-usage-state-'))
    const projects = mkdtempSync(join(tmpdir(), 'scrum-usage-projects-'))
    const sessions = mkdtempSync(join(tmpdir(), 'scrum-usage-sessions-'))
    writeFileSync(join(state, 'config.json'), JSON.stringify(config))
    writeFileSync(join(sessions, '1.json'), JSON.stringify({ pid: 1, sessionId: SESSION_B, name: 'SWE1', status: 'idle', statusUpdatedAt: Date.now() }))
    writeTranscript(join(projects, 'proj', `${SESSION_B}.jsonl`), [assistantLine({ at: new Date().toISOString(), usage: { input_tokens: 1_000_000 } })])
    const e = env(state, projects, sessions)
    const first = run(e, ['runtime'], request({ days: 2 }))
    assert.deepEqual([first.status, (JSON.parse(first.stdout) as Response).error?.status], [1, 503])
    for (let waited = 0; !existsSync(join(state, 'cache', 'usage-index.json')) && waited < 100; waited += 1) await new Promise((resolve) => setTimeout(resolve, 100))
    const second = run(e, ['runtime'], request({ days: 2 }))
    const result = (JSON.parse(second.stdout) as Response).result
    assert.equal(second.status, 0, second.stdout)
    assert.deepEqual(result?.byPerson.map((one) => [one.person, one.costUsd, one.tokens.input]), [['SWE1', 4, 1_000_000]])
    assert.equal(nodeProblem(result as TokenUsage, { org: 'acme', team: 'app', days: 2 }), null)
  })

  it('prints that another process is reading when the lock is held', () => {
    const state = mkdtempSync(join(tmpdir(), 'scrum-usage-state-'))
    writeFileSync(join(state, 'config.json'), JSON.stringify(config))
    mkdirSync(join(state, 'cache'), { recursive: true })
    writeFileSync(join(state, 'cache', 'usage-index.lock'), String(process.pid))
    const out = run(env(state, tmpdir(), tmpdir()), ['usage-index'])
    assert.match(out.stdout, /Another process/)
  })
})
