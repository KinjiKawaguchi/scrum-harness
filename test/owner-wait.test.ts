import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runRuntime, type RuntimeDeps } from '../src/agency-runtime/handle.ts'
import type { ParticipantMetrics } from '../src/agency-runtime/types.ts'
import { answer, close, parseNewRequest } from '../src/requests/model.ts'
import { writeRequest } from '../src/requests/store.ts'
import type { OwnerRequest } from '../src/requests/types.ts'
import { ownerWaits } from '../src/requests/waits.ts'
import { paths, type Paths } from '../src/store.ts'
import { appendStateMark, type StateMark } from '../src/team/state-log.ts'
import { stateSecondsByMember } from '../src/team/state-time.ts'
import type { ActivityState } from '../src/team/types.ts'
import { EMPTY_INDEX, type UsageIndex } from '../src/usage/index-store.ts'
import { config } from './agency-runtime-board.ts'
import { fakePorts } from './fake-ports.ts'
import { NOW } from './helpers.ts'
import { writeIndexForTest } from './usage-index-file.ts'

const at = (hhmm: string): Date => new Date(`2026-10-08T${hhmm}:00Z`)
const ms = (hhmm: string): number => at(hhmm).getTime()

function filed(from: string, createdAt: string, raw: object = {}): OwnerRequest {
  const result = parseNewRequest({ title: 'Which database?', ...raw }, from, at(createdAt), `r-20261008-${createdAt.replace(':', '')}00-a1b2`)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

describe('the time requests waited for the owner', () => {
  it('runs from the time a request was filed to the owner\'s verified answer', () => {
    const request = answer(filed('SWE1', '02:00'), { text: 'SQLite' }, at('03:15'), 'alice')
    assert.deepEqual(ownerWaits([request], NOW), [{ name: 'SWE1', from: ms('02:00'), to: ms('03:15') }])
  })

  it('runs to now while the request is not answered, and to the time it was closed when it was closed without an answer', () => {
    const open = filed('SWE1', '04:00')
    assert.deepEqual(ownerWaits([open], at('05:00')), [{ name: 'SWE1', from: ms('04:00'), to: ms('05:00') }])
    assert.deepEqual(ownerWaits([close(open, 'no longer needed', at('04:20'))], at('05:00')), [{ name: 'SWE1', from: ms('04:00'), to: ms('04:20') }])
  })

  it('leaves out a request addressed to another member of the team, which waits for an agent and not for a person', () => {
    assert.deepEqual(ownerWaits([filed('SWE1', '02:00', { to: 'TechLead' })], NOW), [])
  })

  it('does not run past now, nor start after it', () => {
    assert.deepEqual(ownerWaits([filed('SWE1', '07:00')], at('06:00')), [])
  })
})

describe('the time a member is waiting, with the owner\'s answer', () => {
  const mark = (time: string, sessionId: string, state: ActivityState, name = 'SWE1'): StateMark => ({ at: `2026-10-08T${time}:00Z`, sessionId, name, state })
  const sessions = new Map([['s1', { isAlive: false, updatedAt: '2026-10-08T05:00:00Z' }]])
  const run = (marks: readonly StateMark[], waits: readonly { name: string; from: number; to: number }[], recordedSince: Date | null = null) =>
    stateSecondsByMember({ marks, sessions, days: 1, now: NOW, offsetMinutes: 0, recordedSince, ownerWaits: waits })[0]?.byDay.at(-1)

  it('counts the idle time of a request that waits as waiting, and leaves idle time outside it', () => {
    const day = run([mark('01:00', 's1', 'idle'), mark('05:00', 's1', 'ended')], [{ name: 'SWE1', from: ms('02:00'), to: ms('03:30') }])
    assert.deepEqual([day?.waitingSeconds, day?.idleSeconds, day?.busySeconds], [5400, 4 * 3600 - 5400, 0])
  })

  it('does not take time from busy time, and does not add time when no session of the member was alive', () => {
    const day = run([mark('01:00', 's1', 'idle'), mark('02:00', 's1', 'busy'), mark('03:00', 's1', 'idle'), mark('04:00', 's1', 'ended')], [{ name: 'SWE1', from: ms('00:00'), to: ms('06:00') }])
    // alive 01:00 to 04:00: idle, busy for an hour, idle; the request waited from 00:00 to 06:00
    assert.deepEqual([day?.busySeconds, day?.waitingSeconds, day?.idleSeconds], [3600, 7200, 0])
  })

  it('counts from when recording began, as the rest of the time does, and by the base name of the session', () => {
    const day = run([mark('01:00', 's1', 'idle'), mark('05:00', 's1', 'ended')], [{ name: 'SWE1 (2)', from: ms('00:00'), to: ms('03:00') }], at('02:00'))
    assert.deepEqual([day?.waitingSeconds, day?.idleSeconds], [3600, 2 * 3600])
  })

  it('keeps a request of one member out of another', () => {
    const swe2 = stateSecondsByMember({ marks: [mark('01:00', 's1', 'idle'), mark('05:00', 's1', 'ended')], sessions, days: 1, now: NOW, offsetMinutes: 0, ownerWaits: [{ name: 'SWE2', from: ms('00:00'), to: ms('06:00') }] })
    assert.equal(swe2[0]?.byDay.at(-1)?.waitingSeconds, 0)
  })
})

describe('participantMetrics with a request that waited for the owner', () => {
  let p: Paths
  const index: UsageIndex = { ...EMPTY_INDEX, updatedAt: NOW.toISOString(), sessionIds: ['s1'], models: ['claude-opus-5-5'], rows: [[0, Date.parse('2026-10-08T01:30:00Z') / 60_000, 0, 0, 1_000_000, 0, 0, 0, 0]] }
  const deps = (): RuntimeDeps => ({ p, config, now: NOW, ports: fakePorts({ transcripts: { files: () => [], names: () => new Map([['s1', 'SWE1']]), scan: () => { throw new Error('not used') } } }), spawnRefresh: () => undefined, spawnUsageIndex: () => undefined })

  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-owner-wait-')))
    writeIndexForTest(p, index)
    mkdirSync(dirname(p.memberStates), { recursive: true })
    writeFileSync(p.memberStates.replace(/\.jsonl$/, '.since'), '2026-10-01T00:00:00Z\n')
    appendStateMark(p.memberStates, { at: '2026-10-08T01:00:00Z', sessionId: 's1', name: 'SWE1', state: 'idle' })
    appendStateMark(p.memberStates, { at: '2026-10-08T05:00:00Z', sessionId: 's1', name: 'SWE1', state: 'ended' })
    mkdirSync(p.heartbeats, { recursive: true })
    writeFileSync(join(p.heartbeats, 's1.json'), JSON.stringify({ sessionId: 's1', name: 'SWE1', state: 'ended', since: '2026-10-08T05:00:00Z', updatedAt: '2026-10-08T05:00:00Z', isAlive: false, nameSince: null, pid: 2_147_483_646, isLogged: true }))
  })

  it('reports the wait as waiting seconds of the member, as a node reads them, and keeps the day within 24 hours', () => {
    writeRequest(p, answer(filed('SWE1', '02:00'), { text: 'SQLite' }, at('03:30'), 'alice'))
    const output = runRuntime(JSON.stringify({ runtime: 'agency-runtime/1', org: 'acme', team: 'app', op: 'participantMetrics', days: 1, utcOffsetMinutes: 0 }), deps())
    assert.equal(output.exitCode, 0)
    const day = (JSON.parse(output.stdout) as { result: ParticipantMetrics }).result.participants[0]?.byDay[0]
    assert.deepEqual([day?.waitingSeconds, day?.idleSeconds, day?.busySeconds], [5400, 4 * 3600 - 5400, 0])
    assert.ok((day?.waitingSeconds ?? 0) + (day?.idleSeconds ?? 0) + (day?.busySeconds ?? 0) <= 86_400)
  })
})
