import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeHeartbeat } from '../src/team/heartbeat.ts'
import { appendStateMark, keptMarks, readStateMarks, recordingStart, trimStateLog, type StateMark } from '../src/team/state-log.ts'
import { stateSecondsByMember, type SessionLife } from '../src/team/state-time.ts'
import type { ActivityState } from '../src/team/types.ts'
import { paths, readJson, writeJson } from '../src/store.ts'

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

  it('logs the state a heartbeat file already held when the log did not exist, with the time it began', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-state-')))
    const before = { sessionId: 's1', name: 'SWE1', state: 'busy', since: '2026-11-26T08:00:00.000Z', updatedAt: '2026-11-26T08:40:00.000Z', isAlive: true, nameSince: null, pid: null }
    writeJson(join(p.heartbeats, 's1.json'), before)
    writeHeartbeat(p, { sessionId: 's1', name: 'SWE1', pid: null }, 'idle', new Date('2026-11-26T09:30:00Z'))
    assert.deepEqual(readStateMarks(p.memberStates).map((one) => [one.at, one.state]), [['2026-11-26T08:00:00.000Z', 'busy'], ['2026-11-26T09:30:00.000Z', 'idle']])
    writeHeartbeat(p, { sessionId: 's1', name: 'SWE1', pid: null }, 'busy', new Date('2026-11-26T09:40:00Z'))
    assert.equal(readStateMarks(p.memberStates).length, 3)
  })

  it('logs the first line of a member that does not change state, when the same state is heard again', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-state-')))
    const before = { sessionId: 's1', name: 'SWE1', state: 'busy', since: '2026-11-26T08:00:00.000Z', updatedAt: '2026-11-26T08:59:50.000Z', isAlive: true, nameSince: null, pid: null }
    writeJson(join(p.heartbeats, 's1.json'), before)
    writeHeartbeat(p, { sessionId: 's1', name: 'SWE1', pid: null }, 'busy', new Date('2026-11-26T09:00:00Z'))
    assert.deepEqual(readStateMarks(p.memberStates).map((one) => [one.at, one.state]), [['2026-11-26T08:00:00.000Z', 'busy']])
    writeHeartbeat(p, { sessionId: 's1', name: 'SWE1', pid: null }, 'busy', new Date('2026-11-26T09:05:00Z'))
    assert.equal(readStateMarks(p.memberStates).length, 1)
  })

  it('keeps both when a turn ends and the next prompt comes in the same second, whichever process gets there first', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-state-')))
    const identity = { sessionId: 's1', name: 'SWE1', pid: null }
    writeHeartbeat(p, identity, 'busy', new Date('2026-11-26T09:00:00.000Z'))
    // the next prompt's process writes first, then the end of the turn that came before it
    writeHeartbeat(p, identity, 'busy', new Date('2026-11-26T09:10:00.800Z'))
    writeHeartbeat(p, identity, 'idle', new Date('2026-11-26T09:10:00.200Z'))
    assert.deepEqual(readStateMarks(p.memberStates).map((one) => [one.at.slice(11, 23), one.state]), [['09:00:00.000', 'busy'], ['09:10:00.200', 'idle'], ['09:10:00.800', 'busy']])
    assert.equal(readJson<{ state: string }>(join(p.heartbeats, 's1.json'), { state: '' }).state, 'busy')
  })

  it('leaves no lock behind', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-state-')))
    writeHeartbeat(p, { sessionId: 's1', name: 'SWE1', pid: null }, 'busy', NOW)
    assert.equal(existsSync(join(p.heartbeats, 's1.json.lock')), false)
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

  it('counts a session the log has no line for from the state its heartbeat holds', () => {
    const life: SessionLife = { isAlive: true, updatedAt: '2026-11-26T11:00:00Z', name: 'SWE1 (2)', state: 'busy', since: '2026-11-26T08:00:00Z' }
    const [swe1] = today([], { s1: life })
    assert.equal(swe1?.name, 'SWE1')
    assert.deepEqual(swe1?.byDay.at(-1), { date: '2026-11-26', busySeconds: 14_400, idleSeconds: 0, waitingSeconds: 0 })
  })

  it('keeps members apart and ignores what is before the range', () => {
    const marks = [mark('2026-11-01T09:00:00Z', 's1', 'busy'), mark('2026-11-01T10:00:00Z', 's1', 'idle'), mark('2026-11-26T09:00:00Z', 's2', 'busy', 'SWE2')]
    const result = today(marks, { s1: gone('2026-11-01T10:00:00Z'), s2: gone('2026-11-26T09:20:00Z') })
    assert.deepEqual(result.map((member) => member.name), ['SWE1', 'SWE2'])
    assert.equal(result[0]?.byDay.every((day) => day.busySeconds === 0 && day.idleSeconds === 0), true)
    assert.equal(result[1]?.byDay.at(-1)?.busySeconds, 1200)
  })
})

describe('when recording began', () => {
  // The lines the live logs hold: a state a heartbeat file held before the log (busy since 07:48) beside the lines written as the states changed.
  const real = [
    mark('2026-11-26T09:14:39.832Z', 's2', 'busy', 'SWE2'),
    mark('2026-11-26T09:16:22.918Z', 's2', 'idle', 'SWE2'),
    mark('2026-11-26T07:48:32.074Z', 's1', 'busy', 'SWE1'),
    mark('2026-11-26T10:20:02.222Z', 's1', 'idle', 'SWE1'),
    mark('2026-11-26T10:20:06.895Z', 's1', 'busy', 'SWE1'),
  ]
  const afternoon = new Date('2026-11-26T11:00:00Z')
  const run = (recordedSince: Date | null) =>
    stateSecondsByMember({ marks: real, sessions: new Map([['s1', alive('2026-11-26T10:59:00Z')], ['s2', gone('2026-11-26T09:16:22Z')]]), days: 1, now: afternoon, offsetMinutes: 0, recordedSince })

  it('counts a state that began before recording from the start of recording, not from before it', () => {
    const swe1 = run(new Date('2026-11-26T09:06:00Z')).find((one) => one.name === 'SWE1')?.byDay.at(-1)
    // busy 09:06 to 10:20:02, then idle 4 s, then busy to 11:00; not the 07:48 start the heartbeat file gave
    assert.ok(swe1 !== undefined && Math.abs(swe1.busySeconds - 6835) <= 1 && swe1.idleSeconds >= 4 && swe1.idleSeconds <= 5, JSON.stringify(swe1))
    const unclipped = run(null).find((one) => one.name === 'SWE1')?.byDay.at(-1)
    assert.ok((unclipped?.busySeconds ?? 0) > 3 * 3600)
  })

  it('writes the time of the first line beside the log, and keeps it', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-state-')))
    assert.equal(recordingStart(p.memberStates), null)
    appendStateMark(p.memberStates, mark('2026-11-26T07:00:00Z', 's1', 'busy'))
    const first = recordingStart(p.memberStates)
    assert.ok(first !== null && Math.abs(first.getTime() - Date.now()) < 60_000)
    appendStateMark(p.memberStates, mark('2026-11-26T08:00:00Z', 's1', 'idle'))
    assert.equal(recordingStart(p.memberStates)?.getTime(), first?.getTime())
  })

  it('takes the time a log without the marker was made, and writes it down at the next line', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-state-')))
    mkdirSync(dirname(p.memberStates), { recursive: true })
    writeFileSync(p.memberStates, `${JSON.stringify(mark('2026-11-26T07:00:00Z', 's1', 'busy'))}\n`)
    const made = recordingStart(p.memberStates)
    assert.ok(made !== null && Math.abs(made.getTime() - Date.now()) < 60_000)
    appendStateMark(p.memberStates, mark('2026-11-26T08:00:00Z', 's1', 'idle'))
    assert.equal(recordingStart(p.memberStates)?.getTime(), made?.getTime())
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
