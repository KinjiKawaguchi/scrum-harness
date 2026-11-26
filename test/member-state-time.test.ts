import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeHeartbeat } from '../src/team/heartbeat.ts'
import { appendStateMark, keptMarks, readStateMarks, trimStateLog, type StateMark } from '../src/team/state-log.ts'
import { stateSecondsByMember, type SessionLife } from '../src/team/state-time.ts'
import type { ActivityState } from '../src/team/types.ts'
import { paths } from '../src/store.ts'

const mark = (at: string, sessionId: string, state: ActivityState, name = 'SWE1'): StateMark => ({ at, sessionId, name, state })
const alive = (updatedAt: string): SessionLife => ({ isAlive: true, updatedAt })
const gone = (updatedAt: string): SessionLife => ({ isAlive: false, updatedAt })

const NOW = new Date('2026-11-26T12:00:00Z')
const today = (marks: readonly StateMark[], sessions: Record<string, SessionLife>, offsetMinutes = 0, days = 2) =>
  stateSecondsByMember({ marks, sessions: new Map(Object.entries(sessions)), days, now: NOW, offsetMinutes })

describe('the state log written by the heartbeat', () => {
  it('records a state change, not a heartbeat that only continues a state', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-state-')))
    const identity = { sessionId: 's1', name: 'SWE1 (2)', pid: null }
    writeHeartbeat(p, identity, 'busy', new Date('2026-11-26T09:00:00Z'))
    writeHeartbeat(p, identity, 'busy', new Date('2026-11-26T09:00:10Z'))
    writeHeartbeat(p, identity, 'busy', new Date('2026-11-26T09:01:00Z'))
    writeHeartbeat(p, identity, 'idle', new Date('2026-11-26T09:05:00Z'))
    assert.deepEqual(readStateMarks(p.memberStates), [
      { at: '2026-11-26T09:00:00.000Z', sessionId: 's1', name: 'SWE1', state: 'busy' },
      { at: '2026-11-26T09:05:00.000Z', sessionId: 's1', name: 'SWE1', state: 'idle' },
    ])
  })

  it('drops a line it cannot read', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-state-')))
    appendStateMark(p.memberStates, mark('2026-11-26T09:00:00Z', 's1', 'busy'))
    appendStateMark(p.memberStates, mark('not a time', 's1', 'idle'))
    assert.equal(readStateMarks(p.memberStates).length, 1)
  })
})

describe('stateSecondsByMember', () => {
  it('counts each mark until the next one, and the last one until now while the session runs', () => {
    const [swe1] = today([mark('2026-11-26T09:00:00Z', 's1', 'busy'), mark('2026-11-26T10:00:00Z', 's1', 'idle')], { s1: alive('2026-11-26T11:59:00Z') })
    assert.deepEqual(swe1?.byDay.at(-1), { date: '2026-11-26', busySeconds: 3600, idleSeconds: 7200, waitingSeconds: 0 })
  })

  it('stops counting a session that is gone at its last heartbeat', () => {
    const [swe1] = today([mark('2026-11-26T09:00:00Z', 's1', 'busy')], { s1: gone('2026-11-26T09:30:00Z') })
    assert.equal(swe1?.byDay.at(-1)?.busySeconds, 1800)
  })

  it('counts nothing for a session with no heartbeat, since nothing says how long it lasted', () => {
    assert.deepEqual(today([mark('2026-11-26T09:00:00Z', 's1', 'busy')], {}), [])
  })

  it('counts nothing after a session ended', () => {
    const [swe1] = today([mark('2026-11-26T09:00:00Z', 's1', 'busy'), mark('2026-11-26T09:10:00Z', 's1', 'ended')], { s1: gone('2026-11-26T09:10:00Z') })
    assert.deepEqual(swe1?.byDay.at(-1), { date: '2026-11-26', busySeconds: 600, idleSeconds: 0, waitingSeconds: 0 })
  })

  it('merges two sessions of a member: busy beats waiting beats idle, and an overlap counts once', () => {
    const marks = [
      mark('2026-11-26T09:00:00Z', 'a', 'busy'),
      mark('2026-11-26T09:30:00Z', 'a', 'ended'),
      mark('2026-11-26T09:10:00Z', 'b', 'waiting'),
      mark('2026-11-26T09:50:00Z', 'b', 'idle'),
    ]
    const [swe1] = today(marks, { a: gone('2026-11-26T09:30:00Z'), b: gone('2026-11-26T10:00:00Z') })
    // busy 09:00-09:30, waiting 09:30-09:50 (busy beats waiting before that), idle 09:50-10:00
    assert.deepEqual(swe1?.byDay.at(-1), { date: '2026-11-26', busySeconds: 1800, idleSeconds: 600, waitingSeconds: 1200 })
  })

  it('counts a session that spans midnight on both days, in the offset time zone', () => {
    const marks = [mark('2026-11-25T23:30:00Z', 's1', 'busy'), mark('2026-11-26T01:00:00Z', 's1', 'idle')]
    const [utc] = today(marks, { s1: gone('2026-11-26T01:00:00Z') })
    assert.deepEqual(utc?.byDay.map((day) => [day.date, day.busySeconds]), [['2026-11-25', 1800], ['2026-11-26', 3600]])
    const [tokyo] = today(marks, { s1: gone('2026-11-26T01:00:00Z') }, 540)
    assert.deepEqual(tokyo?.byDay.map((day) => [day.date, day.busySeconds]), [['2026-11-25', 0], ['2026-11-26', 5400]])
  })

  it('keeps members apart and ignores what is before the range', () => {
    const marks = [mark('2026-11-01T09:00:00Z', 's1', 'busy'), mark('2026-11-01T10:00:00Z', 's1', 'idle'), mark('2026-11-26T09:00:00Z', 's2', 'busy', 'SWE2')]
    const result = today(marks, { s1: gone('2026-11-01T10:00:00Z'), s2: gone('2026-11-26T09:20:00Z') })
    assert.deepEqual(result.map((member) => member.name), ['SWE1', 'SWE2'])
    assert.equal(result[0]?.byDay.every((day) => day.busySeconds === 0 && day.idleSeconds === 0), true)
    assert.equal(result[1]?.byDay.at(-1)?.busySeconds, 1200)
  })
})

describe('trimming the state log', () => {
  const old = '2026-06-01T09:00:00Z'
  it('keeps the last mark before the window of each session, and drops the older ones', () => {
    const marks = [mark('2026-05-01T09:00:00Z', 's1', 'busy'), mark(old, 's1', 'idle'), mark('2026-11-20T09:00:00Z', 's1', 'busy'), mark('2026-05-02T09:00:00Z', 's2', 'busy', 'SWE2')]
    assert.deepEqual(keptMarks(marks, NOW).map((one) => [one.sessionId, one.at]), [['s2', '2026-05-02T09:00:00Z'], ['s1', old], ['s1', '2026-11-20T09:00:00Z']])
  })

  it('rewrites the file only when something can go', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-state-')))
    appendStateMark(p.memberStates, mark('2026-05-01T09:00:00Z', 's1', 'busy'))
    appendStateMark(p.memberStates, mark(old, 's1', 'idle'))
    appendStateMark(p.memberStates, mark('2026-11-20T09:00:00Z', 's1', 'busy'))
    trimStateLog(p.memberStates, NOW)
    assert.equal(readFileSync(p.memberStates, 'utf8').trim().split('\n').length, 2)
    const before = readFileSync(p.memberStates, 'utf8')
    trimStateLog(p.memberStates, NOW)
    assert.equal(readFileSync(p.memberStates, 'utf8'), before)
  })
})
