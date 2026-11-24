import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { dispatchOnce, formatOnce } from '../src/dispatch/once.ts'
import type { Exec } from '../src/dispatch/run.ts'
import { addAck } from '../src/findings/acks.ts'
import { paths, writeJson, type Paths } from '../src/store.ts'
import { writeHeartbeat } from '../src/team/heartbeat.ts'
import type { ActivityState } from '../src/team/types.ts'
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
  process.env.SCRUM_SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'scrum-sessions-'))
  calls = []
  saveSnapshot(p, snapshot([issue(11, { status: '次にやる', title: '次の仕事' }), issue(12, { status: '次にやる', title: '二つ目' })]))
})

afterEach(() => {
  delete process.env.SCRUM_SESSIONS_DIR
})

describe('dispatchOnce', () => {
  it('すでに空いている部下に、1 回だけ、渡す。ボードの書き換えは待機と同じ道で、文面を返す', () => {
    state('SWE1', 'idle', 30)
    const [result] = dispatchOnce(p, enabled, NOW, exec, ['SWE1'], noGithub)
    assert.equal(result?.member, 'SWE1')
    assert.match(result?.outcome?.message ?? '', /^scrum-harness: SWE1 に次の仕事を渡した。\napp#11 次の仕事/)
    assert.deepEqual(calls, [['set-tanto', ['11', 'SWE1']], ['set-status', ['11', '作業中']]])
  })

  it('名前を渡さなければ、渡す相手 (dispatch.members) の全員を見て、同じ issue を 2 人に渡さない', () => {
    state('SWE1', 'idle', 30)
    state('SWE2', 'idle', 30)
    const results = dispatchOnce(p, enabled, NOW, exec, [], noGithub)
    assert.deepEqual(results.map((result) => result.member), ['SWE1', 'SWE2'])
    assert.deepEqual(results.map((result) => result.outcome?.record.label), ['app#11', 'app#12'])
  })

  it('空きでない人、空きが短い人、受け入れがある人には渡さず、理由を返す', () => {
    state('SWE1', 'busy', 30)
    state('SWE2', 'idle', 5)
    const results = dispatchOnce(p, enabled, NOW, exec, [], noGithub)
    assert.deepEqual(results.map((result) => result.reason), ['空きではない', '空きが idleMinutes に届いていない'])
    assert.deepEqual(calls, [])
    state('SWE1', 'idle', 30)
    writeJson(p.acks, addAck([], { rule: 'T-IDLE', subject: 'SWE1', until: new Date(NOW.getTime() + 30 * 60_000).toISOString(), reason: 'オーナーの答え待ち', at: NOW.toISOString() }, NOW))
    assert.deepEqual(dispatchOnce(p, enabled, NOW, exec, ['SWE1'], noGithub).map((result) => result.reason), ['有効な T-IDLE の受け入れがある'])
  })

  it('空いているが、渡せるものが無い人は、その理由を返す', () => {
    saveSnapshot(p, snapshot([]))
    state('SWE1', 'idle', 30)
    assert.deepEqual(dispatchOnce(p, enabled, NOW, exec, ['SWE1'], noGithub).map((result) => result.reason), ['渡せる issue が無い (Q-EMPTY の対象)'])
  })

  it('作業が進んでいる人 (前に見た印から変わった) は、促さず、その理由を返す', () => {
    saveSnapshot(p, snapshot([issue(240, { status: '作業中', tanto: 'SWE1' })]))
    state('SWE1', 'idle', 30)
    assert.notEqual(dispatchOnce(p, enabled, NOW, exec, ['SWE1'], () => 'a')[0]?.outcome, null)
    const later = new Date(NOW.getTime() + 12 * 60_000)
    state('SWE1', 'idle', 30)
    const second = dispatchOnce(p, enabled, later, exec, ['SWE1'], () => 'b')[0]
    assert.deepEqual([second?.outcome, second?.reason], [null, '作業が進んでいる (最後に印が変わってから idleMinutes たっていない)'])
  })

  it('dispatch が有効でなければ、何も渡さず、理由を返す', () => {
    state('SWE1', 'idle', 30)
    const [result] = dispatchOnce(p, { ...enabled, dispatch: { ...enabled.dispatch, enabled: false } }, NOW, exec, ['SWE1'], noGithub)
    assert.deepEqual([result?.outcome, result?.reason], [null, 'dispatch.enabled が true でない'])
    assert.deepEqual(calls, [])
  })

  it('心拍の無い名前は、読めない理由を返す', () => {
    const [result] = dispatchOnce(p, enabled, NOW, exec, ['だれか'], noGithub)
    assert.match(result?.reason ?? '', /セッションの稼働を読めない/)
  })
})

describe('formatOnce', () => {
  it('送る人ごとに、送り先と文面を並べる。送らない人は理由を 1 行で出す', () => {
    state('SWE1', 'idle', 30)
    state('SWE2', 'busy', 30)
    const text = formatOnce(dispatchOnce(p, enabled, NOW, exec, [], noGithub))
    assert.match(text, /^SWE1: 送る \(渡した app#11\)\nSWE2: 送らない \(空きではない\)\n/)
    assert.match(text, /--- SWE1 のセッションに、次の文を SendMessage で送る ---\nscrum-harness: SWE1 に次の仕事を渡した。/)
    assert.doesNotMatch(text, /SWE2 のセッションに/)
  })

  it('1 人にも送らなければ、送る文は無いと書く', () => {
    state('SWE1', 'busy', 30)
    assert.match(formatOnce(dispatchOnce(p, enabled, NOW, exec, ['SWE1'], noGithub)), /送る文は無い$/)
  })
})
