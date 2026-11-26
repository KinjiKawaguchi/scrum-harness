import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRuntime, type RuntimeDeps } from '../src/agency-runtime/handle.ts'
import { parseRuntimeRequest } from '../src/agency-runtime/request.ts'
import type { ParticipantMetrics } from '../src/agency-runtime/types.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { formatParticipantMetrics } from '../src/metrics/participants-text.ts'
import { paths, writeJson, type Paths } from '../src/store.ts'
import { recordPrAuthor } from '../src/team/pr-authors.ts'
import { appendStateMark } from '../src/team/state-log.ts'
import type { ActivityState } from '../src/team/types.ts'
import { EMPTY_INDEX, type CompactRow, type UsageIndex } from '../src/usage/index-store.ts'
import { config } from './agency-runtime-board.ts'
import { fakePorts } from './fake-ports.ts'
import { NOW, pr, snapshot } from './helpers.ts'
import { SESSION_A, SESSION_B, SESSION_OTHER } from './usage-fixtures.ts'
import { writeIndexForTest } from './usage-index-file.ts'

type Response = { result?: ParticipantMetrics; error?: { status: number; message: string } }
const request = (extra: object = {}) => JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'participantMetrics', days: 2, ...extra })

let p: Paths
let spawns = 0

const deps = (): RuntimeDeps => ({
  p,
  config,
  now: NOW,
  ports: fakePorts({ transcripts: { files: () => [], names: () => new Map([[SESSION_A, 'TechLead'], [SESSION_B, 'SWE1'], [SESSION_OTHER, 'Stranger']]), scan: () => { throw new Error('not used') } } }),
  spawnRefresh: () => undefined,
  spawnUsageIndex: () => {
    spawns += 1
  },
})
const call = (input: string) => {
  const output = runRuntime(input, deps())
  return { exitCode: output.exitCode, response: JSON.parse(output.stdout) as Response }
}

const minute = (iso: string) => Date.parse(iso) / 60_000
/** $4 of the default model, and a million input tokens */
const row = (session: number, iso: string): CompactRow => [session, minute(iso), 0, 0, 1_000_000, 0, 0, 0, 0]
const index = (rows: readonly CompactRow[]): UsageIndex => ({ ...EMPTY_INDEX, updatedAt: NOW.toISOString(), sessionIds: [SESSION_A, SESSION_B, SESSION_OTHER], models: ['claude-opus-5-5'], rows })
const mark = (at: string, sessionId: string, state: ActivityState, name: string) => appendStateMark(p.memberStates, { at, sessionId, name, state })
const heartbeat = (sessionId: string, name: string, updatedAt: string) =>
  writeJson(join(p.heartbeats, `${sessionId}.json`), { sessionId, name, state: 'idle', since: updatedAt, updatedAt, isAlive: false, nameSince: null, pid: 1, isLogged: true })

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-participants-')))
  spawns = 0
})

describe('participantMetrics requests', () => {
  it('takes days from 1 to 90 and an optional whole-minute offset from -720 to 840', () => {
    assert.deepEqual(parseRuntimeRequest(request({ days: 7 })), { runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'participantMetrics', days: 7 })
    assert.deepEqual(parseRuntimeRequest(request({ utcOffsetMinutes: 540 })), { runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'participantMetrics', days: 2, utcOffsetMinutes: 540 })
    for (const bad of [{ days: 0 }, { days: 91 }, { days: 1.5 }, { days: undefined }, { utcOffsetMinutes: 841 }, { utcOffsetMinutes: -721 }, { utcOffsetMinutes: 30.5 }, { utcOffsetMinutes: '540' }]) {
      assert.equal('status' in (parseRuntimeRequest(request(bad)) as object), true, JSON.stringify(bad))
    }
  })

  it('is listed by describe', () => {
    const { response } = call(JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'describe' }))
    assert.equal((response.result as unknown as { ops: string[] }).ops.includes('participantMetrics'), true)
  })

  it('is answered 503 while the token usage has not been read, and starts reading it', () => {
    const { exitCode, response } = call(request())
    assert.deepEqual([exitCode, response.error?.status, spawns], [1, 503, 1])
  })
})

describe('participantMetrics answers', () => {
  const today = '2026-10-08'
  beforeEach(() => {
    writeIndexForTest(p, index([row(1, '2026-10-08T01:00:00Z'), row(1, '2026-10-07T23:30:00Z'), row(2, '2026-10-08T02:00:00Z')]))
    // recording began before the lines below, as the state log's marker says
    mkdirSync(dirname(p.memberStates), { recursive: true })
    writeFileSync(p.memberStates.replace(/\.jsonl$/, '.since'), '2026-10-01T00:00:00Z\n')
    mark('2026-10-08T00:00:00Z', 'h1', 'busy', 'SWE1')
    mark('2026-10-08T01:00:00Z', 'h1', 'waiting', 'SWE1')
    mark('2026-10-08T01:30:00Z', 'h1', 'idle', 'SWE1')
    mark('2026-10-08T02:00:00Z', 'h1', 'ended', 'SWE1')
    heartbeat('h1', 'SWE1', '2026-10-08T02:00:00Z')
    mark('2026-10-08T03:00:00Z', 'h9', 'busy', 'Stranger')
    heartbeat('h9', 'Stranger', '2026-10-08T04:00:00Z')
  })

  it('gives each participant of the team the time its sessions were alive, its cost, and its tokens, by day', () => {
    const { exitCode, response } = call(request())
    assert.equal(exitCode, 0)
    const report = response.result
    assert.deepEqual([report?.org, report?.team, report?.days, report?.generatedAt, report?.utcOffsetMinutes], ['acme', 'app', 2, NOW.toISOString(), 0])
    assert.deepEqual(report?.participants.map((one) => one.name), ['SWE1'])
    const swe1 = report?.participants.find((one) => one.name === 'SWE1')
    assert.deepEqual(swe1?.byDay.map((day) => day.date), ['2026-10-07', today])
    assert.deepEqual(swe1?.byDay.at(-1), { date: today, busySeconds: 3600, waitingSeconds: 1800, idleSeconds: 1800, costUsd: 4, tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } })
    assert.deepEqual(swe1?.byDay[0], { date: '2026-10-07', busySeconds: 0, waitingSeconds: 0, idleSeconds: 0, costUsd: 4, tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } })
  })

  it('cuts the days at the offset the node asks for and says which it used', () => {
    const report = call(request({ utcOffsetMinutes: 540 })).response.result
    assert.equal(report?.utcOffsetMinutes, 540)
    const swe1 = report?.participants.find((one) => one.name === 'SWE1')
    // 2026-10-07T23:30Z is 08:30 on the 8th at +09:00, so both of SWE1's rows are on the 8th
    assert.deepEqual(swe1?.byDay.map((day) => [day.date, day.costUsd]), [['2026-10-08', 8]])
  })

  it('leaves out a participant that is not on the team, and a day with nothing in it', () => {
    const report = call(request({ days: 5 })).response.result
    assert.equal(report?.participants.some((one) => one.name === 'Stranger'), false)
    assert.equal(report?.participants.every((one) => one.byDay.every((day) => day.busySeconds + day.waitingSeconds + day.idleSeconds + day.costUsd > 0)), true)
  })

  it('passes the checks the node makes: each participant once, days in range and in order, time within 25 hours, finite costs', () => {
    const report = call(request({ days: 2 })).response.result
    assert.ok(report)
    assert.equal(new Set(report.participants.map((one) => one.name)).size, report.participants.length)
    for (const one of report.participants) {
      assert.ok(one.byDay.length <= report.days)
      assert.deepEqual(one.byDay.map((day) => day.date), one.byDay.map((day) => day.date).toSorted())
      for (const day of one.byDay) {
        assert.ok(day.busySeconds + day.waitingSeconds + day.idleSeconds <= 25 * 3600)
        assert.ok(Number.isFinite(day.costUsd) && day.costUsd >= 0)
        assert.ok([day.busySeconds, day.waitingSeconds, day.idleSeconds, ...Object.values(day.tokens)].every((count) => Number.isInteger(count) && count >= 0))
      }
    }
  })
})

describe('participantMetrics pull requests', () => {
  beforeEach(() => {
    writeIndexForTest(p, index([]))
  })
  const author = (ref: string, name: string, extra: object = {}) => recordPrAuthor(p.prAuthors, { at: '2026-10-08T01:00:00Z', name, sessionId: 's1', ref, ...extra })

  it('lists a pull request once with the repository as owner/name, whose author the hooks saw', () => {
    author('app#42', 'SWE1 (2)', { repo: 'acme/app', number: 42 })
    author('app#42', 'SWE2', { repo: 'acme/app', number: 42 })
    assert.deepEqual(call(request()).response.result?.pullRequests, [{ repo: 'acme/app', number: 42, by: 'SWE1' }])
  })

  it('finds the repository of an older record on the board when no configured repository has that name, and leaves out a pull request it cannot place', () => {
    saveSnapshot(p, snapshot([pr(9, { repo: 'acme/elsewhere' })]))
    author('elsewhere#9', 'SWE1')
    author('elsewhere#77', 'SWE2')
    assert.deepEqual(call(request()).response.result?.pullRequests, [{ repo: 'acme/elsewhere', number: 9, by: 'SWE1' }])
  })

  it('names the repository of an older record, which holds only the short reference, from the configured repositories', () => {
    // the lines the live logs hold before the repository was kept: only the reference
    author('app#330', 'SWE1')
    author('other#7', 'SWE2')
    assert.deepEqual(call(request()).response.result?.pullRequests, [{ repo: 'example-org/app', number: 330, by: 'SWE1' }])
  })

  it('is empty when no author is known', () => {
    assert.deepEqual(call(request()).response.result?.pullRequests, [])
  })
})

describe('the report for people', () => {
  it('shows the days of each participant and the pull requests, and says what counts', () => {
    const text = formatParticipantMetrics({
      org: 'acme',
      team: 'app',
      days: 2,
      generatedAt: NOW.toISOString(),
      utcOffsetMinutes: 540,
      participants: [{ name: 'SWE1', byDay: [{ date: '2026-10-08', busySeconds: 7500, waitingSeconds: 600, idleSeconds: 0, costUsd: 4.5, tokens: { input: 1_000_000, output: 2000, cacheRead: 50_000, cacheWrite: 0 } }] }],
      pullRequests: [{ repo: 'acme/app', number: 42, by: 'SWE1' }],
    })
    assert.match(text, /^app: the last 2 days \(UTC\+09:00\)/)
    assert.match(text, /2026-10-08 +2h05 +10m +- +\$4\.50/)
    assert.match(text, /total +2h05 +10m +- +\$4\.50/)
    assert.match(text, /acme\/app#42 +SWE1/)
    assert.match(text, /overlapping sessions count once/)
  })
})
