import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { dispatchOnce, formatOnce } from '../src/dispatch/once.ts'
import type { Exec } from '../src/adapters/github/board-writer.ts'
import { addAck } from '../src/findings/acks.ts'
import { paths, writeJson, type Paths } from '../src/store.ts'
import { writeHeartbeat } from '../src/team/heartbeat.ts'
import type { ActivityState } from '../src/team/types.ts'
import { dispatchPorts, fakePorts } from './fake-ports.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

const enabled = { ...config, dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], utcOffset: '+09:00', notes: [], members: ['SWE1', 'SWE2'] } }
let p: Paths
let calls: (readonly [string, readonly string[]])[]
const exec: Exec = (script, args) => {
  calls.push([script, args])
}
const noGithub = (): null => null

function state(name: string, kind: ActivityState, minutes: number): void {
  writeHeartbeat(p, { sessionId: `session-${name}`, name, pid: null }, kind, new Date(NOW.getTime() - minutes * 60_000))
}

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-once-')))
  calls = []
  saveSnapshot(p, snapshot([issue(11, { status: 'Next', title: 'Next job' }), issue(12, { status: 'Next', title: 'Second job' })]))
})

describe('dispatchOnce', () => {
  it('hands over exactly once to a member who is already idle; the board rewrite goes the same way as a watch, and the message is returned', () => {
    state('SWE1', 'idle', 30)
    const [result] = dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), ['SWE1'])
    assert.equal(result?.member, 'SWE1')
    assert.match(result?.outcome?.message ?? '', /^scrum-harness: handed the next work to SWE1\.\napp#11 Next job/)
    assert.deepEqual(calls, [['set-assignee', ['11', 'SWE1']], ['set-status', ['11', 'In Progress']]])
  })

  it('when no name is given, looks at everyone in the hand-over targets (dispatch.members) and does not give the same issue to 2 people', () => {
    state('SWE1', 'idle', 30)
    state('SWE2', 'idle', 30)
    const results = dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), [])
    assert.deepEqual(results.map((result) => result.member), ['SWE1', 'SWE2'])
    assert.deepEqual(results.map((result) => result.outcome?.record.label), ['app#11', 'app#12'])
  })

  it('does not hand over to a person who is not idle, whose idle time is short, or who has an acknowledgement, and returns the reason', () => {
    state('SWE1', 'busy', 30)
    state('SWE2', 'idle', 5)
    const results = dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), [])
    assert.deepEqual(results.map((result) => result.reason), ['not idle', 'idle for less than idleMinutes'])
    assert.deepEqual(calls, [])
    state('SWE1', 'idle', 30)
    writeJson(p.acks, addAck([], { rule: 'T-IDLE', subject: 'SWE1', until: new Date(NOW.getTime() + 30 * 60_000).toISOString(), reason: "Waiting for the owner's answer", at: NOW.toISOString() }, NOW))
    assert.deepEqual(dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), ['SWE1']).map((result) => result.reason), ['a valid T-IDLE acknowledgement exists'])
  })

  it('returns the reason for a person who is idle but has nothing to hand over', () => {
    saveSnapshot(p, snapshot([]))
    state('SWE1', 'idle', 30)
    assert.deepEqual(dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), ['SWE1']).map((result) => result.reason), ['no issue to hand over (subject to Q-EMPTY)'])
  })

  it('does not nudge a person whose work is progressing (the marker differs from the one seen before), and returns the reason', () => {
    saveSnapshot(p, snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })]))
    state('SWE1', 'idle', 30)
    assert.notEqual(dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, () => 'a'), ['SWE1'])[0]?.outcome, null)
    const later = new Date(NOW.getTime() + 12 * 60_000)
    state('SWE1', 'idle', 30)
    const second = dispatchOnce(p, enabled, later, dispatchPorts(enabled, exec, () => 'b'), ['SWE1'])[0]
    assert.deepEqual([second?.outcome, second?.reason], [null, 'work is progressing (idleMinutes have not passed since the marker last changed)'])
  })

  it('hands over nothing and returns the reason when dispatch is not enabled', () => {
    state('SWE1', 'idle', 30)
    const [result] = dispatchOnce(p, { ...enabled, dispatch: { ...enabled.dispatch, enabled: false } }, NOW, dispatchPorts({ ...enabled, dispatch: { ...enabled.dispatch, enabled: false } }, exec, noGithub), ['SWE1'])
    assert.deepEqual([result?.outcome, result?.reason], [null, 'dispatch.enabled is not true'])
    assert.deepEqual(calls, [])
  })

  it('returns the reason that a name without a heartbeat cannot be read', () => {
    const [result] = dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), ['someone'])
    assert.match(result?.reason ?? '', /cannot read the session activity/)
  })
})

describe('formatOnce', () => {
  it('for each person to send to, lists the destination and the message; a person not sent to gets their reason on one line', () => {
    state('SWE1', 'idle', 30)
    state('SWE2', 'busy', 30)
    const text = formatOnce(dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), []))
    assert.match(text, /^SWE1: sending \(handed over app#11\)\nSWE2: not sending \(not idle\)\n/)
    assert.match(text, /--- send this text to SWE1's session with SendMessage ---\nscrum-harness: handed the next work to SWE1\./)
    assert.doesNotMatch(text, /send this text to SWE2's session/)
  })

  it('when nobody is sent anything, writes that there is no message to send', () => {
    state('SWE1', 'busy', 30)
    assert.match(formatOnce(dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), ['SWE1'])), /nothing to send$/)
  })
})
