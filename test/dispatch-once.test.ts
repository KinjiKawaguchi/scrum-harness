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
  it('すでに空いている部下に、1 回だけ、渡す。ボードの書き換えは待機と同じ道で、文面を返す', () => {
    state('SWE1', 'idle', 30)
    const [result] = dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), ['SWE1'])
    assert.equal(result?.member, 'SWE1')
    assert.match(result?.outcome?.message ?? '', /^scrum-harness: handed the next work to SWE1\.\napp#11 Next job/)
    assert.deepEqual(calls, [['set-assignee', ['11', 'SWE1']], ['set-status', ['11', 'In Progress']]])
  })

  it('名前を渡さなければ、渡す相手 (dispatch.members) の全員を見て、同じ issue を 2 人に渡さない', () => {
    state('SWE1', 'idle', 30)
    state('SWE2', 'idle', 30)
    const results = dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), [])
    assert.deepEqual(results.map((result) => result.member), ['SWE1', 'SWE2'])
    assert.deepEqual(results.map((result) => result.outcome?.record.label), ['app#11', 'app#12'])
  })

  it('空きでない人、空きが短い人、受け入れがある人には渡さず、理由を返す', () => {
    state('SWE1', 'busy', 30)
    state('SWE2', 'idle', 5)
    const results = dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), [])
    assert.deepEqual(results.map((result) => result.reason), ['not idle', 'idle for less than idleMinutes'])
    assert.deepEqual(calls, [])
    state('SWE1', 'idle', 30)
    writeJson(p.acks, addAck([], { rule: 'T-IDLE', subject: 'SWE1', until: new Date(NOW.getTime() + 30 * 60_000).toISOString(), reason: "Waiting for the owner's answer", at: NOW.toISOString() }, NOW))
    assert.deepEqual(dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), ['SWE1']).map((result) => result.reason), ['a valid T-IDLE acknowledgement exists'])
  })

  it('空いているが、渡せるものが無い人は、その理由を返す', () => {
    saveSnapshot(p, snapshot([]))
    state('SWE1', 'idle', 30)
    assert.deepEqual(dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), ['SWE1']).map((result) => result.reason), ['no issue to hand over (subject to Q-EMPTY)'])
  })

  it('作業が進んでいる人 (前に見た印から変わった) は、促さず、その理由を返す', () => {
    saveSnapshot(p, snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })]))
    state('SWE1', 'idle', 30)
    assert.notEqual(dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, () => 'a'), ['SWE1'])[0]?.outcome, null)
    const later = new Date(NOW.getTime() + 12 * 60_000)
    state('SWE1', 'idle', 30)
    const second = dispatchOnce(p, enabled, later, dispatchPorts(enabled, exec, () => 'b'), ['SWE1'])[0]
    assert.deepEqual([second?.outcome, second?.reason], [null, 'work is progressing (idleMinutes have not passed since the marker last changed)'])
  })

  it('dispatch が有効でなければ、何も渡さず、理由を返す', () => {
    state('SWE1', 'idle', 30)
    const [result] = dispatchOnce(p, { ...enabled, dispatch: { ...enabled.dispatch, enabled: false } }, NOW, dispatchPorts({ ...enabled, dispatch: { ...enabled.dispatch, enabled: false } }, exec, noGithub), ['SWE1'])
    assert.deepEqual([result?.outcome, result?.reason], [null, 'dispatch.enabled is not true'])
    assert.deepEqual(calls, [])
  })

  it('心拍の無い名前は、読めない理由を返す', () => {
    const [result] = dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), ['someone'])
    assert.match(result?.reason ?? '', /cannot read the session activity/)
  })
})

describe('formatOnce', () => {
  it('送る人ごとに、送り先と文面を並べる。送らない人は理由を 1 行で出す', () => {
    state('SWE1', 'idle', 30)
    state('SWE2', 'busy', 30)
    const text = formatOnce(dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), []))
    assert.match(text, /^SWE1: sending \(handed over app#11\)\nSWE2: not sending \(not idle\)\n/)
    assert.match(text, /--- send this text to SWE1's session with SendMessage ---\nscrum-harness: handed the next work to SWE1\./)
    assert.doesNotMatch(text, /send this text to SWE2's session/)
  })

  it('1 人にも送らなければ、送る文は無いと書く', () => {
    state('SWE1', 'busy', 30)
    assert.match(formatOnce(dispatchOnce(p, enabled, NOW, dispatchPorts(enabled, exec, noGithub), ['SWE1'])), /nothing to send$/)
  })
})
