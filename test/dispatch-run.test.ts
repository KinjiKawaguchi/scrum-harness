import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSnapshot, saveSnapshot } from '../src/board/snapshot.ts'
import { lintAll, loadContext } from '../src/findings/lint.ts'
import { readDispatches } from '../src/dispatch/records.ts'
import { readSeen } from '../src/dispatch/progress.ts'
import type { Exec } from '../src/adapters/github/board-writer.ts'
import { dispatchStep } from '../src/dispatch/run.ts'
import { addAck, type Ack } from '../src/findings/acks.ts'
import { paths, readJson, writeJson, type Paths } from '../src/store.ts'
import { writeHeartbeat } from '../src/team/heartbeat.ts'
import { dispatchPorts, fakePorts } from './fake-ports.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

const enabled = { ...config, dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], utcOffset: '+09:00', notes: ['今夜の決まり'] } }
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000)

let p: Paths
let calls: (readonly [string, readonly string[]])[]
const exec: Exec = (script, args) => {
  calls.push([script, args])
}

function idleSince(name: string, minutes: number): void {
  writeHeartbeat(p, { sessionId: `session-${name}`, name, pid: null }, 'idle', minutesAgo(minutes))
}

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-dispatch-')))
  calls = []
})

describe('dispatchStep', () => {
  it('空きが続いている部下に、選んだ issue を渡し、担当と Status を書き、記録と控えを直し、文面を返す', () => {
    idleSince('SWE1', 20)
    saveSnapshot(p, snapshot([issue(11, { status: '次にやる', title: '次の仕事' }), issue(12, { status: '次にやる' })]))
    const outcome = dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec))
    assert.deepEqual(calls, [
      ['set-assignee', ['11', 'SWE1']],
      ['set-status', ['11', '作業中']],
    ])
    assert.match(outcome?.message ?? '', /^scrum-harness: SWE1 に次の仕事を渡した。\napp#11 次の仕事\n/)
    assert.deepEqual(readDispatches(p).map((record) => `${record.member} ${record.label}`), ['SWE1 app#11'])
    const item = loadSnapshot(p)?.items.find((one) => one.number === 11)
    assert.deepEqual([item?.status, item?.assignee], ['作業中', 'SWE1'])
    assert.match(readFileSync(p.events, 'utf8'), /"type":"dispatched"/)
  })

  it('担当がすでにその人なら、担当は書き直さない', () => {
    idleSince('SWE1', 20)
    saveSnapshot(p, snapshot([issue(11, { status: '次にやる', assignee: 'SWE1' })]))
    dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec))
    assert.deepEqual(calls, [['set-status', ['11', '作業中']]])
  })

  it('渡した後、その人が動かないままなら、重ねて渡さない', () => {
    idleSince('SWE1', 20)
    saveSnapshot(p, snapshot([issue(11, { status: '次にやる' }), issue(12, { status: '次にやる' })]))
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    calls = []
    assert.equal(dispatchStep(p, enabled, 'SWE1', new Date(NOW.getTime() + 60_000), dispatchPorts(enabled, exec)), null)
    assert.deepEqual(calls, [])
  })

  it('1 つの issue を 2 人に渡さない (先に渡した人の分で、控えが作業中になっている)', () => {
    idleSince('SWE1', 20)
    idleSince('SWE2', 20)
    saveSnapshot(p, snapshot([issue(11, { status: '次にやる' })]))
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    calls = []
    assert.equal(dispatchStep(p, enabled, 'SWE2', NOW, dispatchPorts(enabled, exec)), null)
    assert.deepEqual(calls, [])
  })

  it('空いていない、空きが短い、dispatch が無効、スクリプトが無い、のときは何もしない', () => {
    saveSnapshot(p, snapshot([issue(11, { status: '次にやる' })]))
    writeHeartbeat(p, { sessionId: 'session-SWE1', name: 'SWE1', pid: null }, 'busy', minutesAgo(30))
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    idleSince('SWE2', 5)
    assert.equal(dispatchStep(p, enabled, 'SWE2', NOW, dispatchPorts(enabled, exec)), null)
    idleSince('SWE3', 20)
    assert.equal(dispatchStep(p, config, 'SWE3', NOW, dispatchPorts(config, exec)), null)
    assert.equal(dispatchStep(p, { ...enabled, scripts: {} }, 'SWE3', NOW, dispatchPorts({ ...enabled, scripts: {} }, exec)), null)
    assert.deepEqual(calls, [])
  })

  it('有効な受け入れがある人には渡さない', () => {
    idleSince('SWE1', 20)
    saveSnapshot(p, snapshot([issue(11, { status: '次にやる' })]))
    const ack: Ack = { rule: 'T-IDLE', subject: 'SWE1', until: new Date(NOW.getTime() + 600_000).toISOString(), reason: 'オーナーの答え待ち', at: NOW.toISOString() }
    writeJson(p.acks, addAck([], ack, NOW))
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    assert.deepEqual(calls, [])
  })

  it('渡せるものが無ければ何もしない', () => {
    idleSince('SWE1', 20)
    saveSnapshot(p, snapshot([issue(11, { status: 'バックログ' })]))
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    assert.deepEqual(calls, [])
    assert.deepEqual(readDispatches(p), [])
  })

  it('ほかのプロセスが錠を持っているあいだは渡さない', () => {
    idleSince('SWE1', 20)
    saveSnapshot(p, snapshot([issue(11, { status: '次にやる' })]))
    writeFileSync(p.dispatchLock, String(process.ppid))
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    assert.deepEqual(calls, [])
  })

  it('スクリプトが失敗したら、記録も控えの書き換えもせず、5 分は試さない。その後はまた試す', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(11, { status: '次にやる' })]))
    const failing: Exec = (script, args) => {
      calls.push([script, args])
      throw new Error('gh が落ちた')
    }
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, failing)), null)
    assert.deepEqual(readDispatches(p), [])
    assert.equal(loadSnapshot(p)?.items[0]?.status, '次にやる')
    assert.match(readFileSync(p.errors, 'utf8'), /dispatch: gh が落ちた/)
    assert.ok(readJson<string | null>(p.dispatchFailure, null) !== null)
    calls = []
    assert.equal(dispatchStep(p, enabled, 'SWE1', new Date(NOW.getTime() + 4 * 60_000), dispatchPorts(enabled, exec)), null)
    assert.deepEqual(calls, [])
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', new Date(NOW.getTime() + 6 * 60_000), dispatchPorts(enabled, exec)), null)
  })
})

describe('dispatchStep の促し', () => {
  const later = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000)
  const noGithub = (): null => null

  it('止まっていない自分の作業中があれば、新しい issue は渡さず、ボードを書き換えずに、進めるよう促す', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: '作業中', assignee: 'SWE1', title: '作業中の仕事' }), issue(11, { status: '次にやる' })]))
    const outcome = dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec, noGithub))
    assert.match(outcome?.message ?? '', /^scrum-harness: SWE1 が空いている。作業中の app#240 作業中の仕事 を進める。/)
    assert.deepEqual(calls, [])
    assert.deepEqual(readDispatches(p).map((record) => `${record.kind} ${record.label}`), ['nudge app#240'])
    assert.equal(loadSnapshot(p)?.items.find((one) => one.number === 11)?.status, '次にやる')
    assert.match(readFileSync(p.events, 'utf8'), /"type":"nudged","count":1/)
  })

  it('促しは idleMinutes ごとに、2 回まで。3 回目は送らない', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: '作業中', assignee: 'SWE1' })]))
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec, noGithub)), null)
    assert.equal(dispatchStep(p, enabled, 'SWE1', later(5), dispatchPorts(enabled, exec, noGithub)), null)
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', later(11), dispatchPorts(enabled, exec, noGithub)), null)
    assert.equal(dispatchStep(p, enabled, 'SWE1', later(30), dispatchPorts(enabled, exec, noGithub)), null)
    assert.deepEqual(readDispatches(p).map((record) => record.kind), ['nudge', 'nudge'])
    assert.deepEqual(calls, [])
  })

  it('作業中が止まっていれば、促さずに次の issue を渡す', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: '作業中', assignee: 'SWE1', reason: '外部待ち' }), issue(11, { status: '次にやる' })]))
    const outcome = dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec))
    assert.match(outcome?.message ?? '', /次の仕事を渡した。\napp#11/)
    assert.equal(calls.length, 2)
  })
})

describe('dispatchStep の促しの数え方', () => {
  const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000)
  const noGithub = (): null => null
  const busyThenIdle = (busyAt: number, idleAt: number): void => {
    const who = { sessionId: 'session-SWE1', name: 'SWE1', pid: null }
    writeHeartbeat(p, who, 'busy', at(busyAt))
    writeHeartbeat(p, who, 'idle', at(idleAt))
  }

  it('促しの後、短い 1 ターンで空きに戻るのを繰り返しても、作業が進まなければ、2 回で止まり、A-NUDGE-IGNORED が出る', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: '作業中', assignee: 'SWE1' })]))
    const sent: boolean[] = []
    for (let round = 0; round < 6; round++) {
      const start = round * 12
      if (round > 0) busyThenIdle(start - 11, start - 10)
      sent.push(dispatchStep(p, enabled, 'SWE1', at(start), dispatchPorts(enabled, exec, noGithub)) !== null)
    }
    assert.deepEqual(sent, [true, true, false, false, false, false])
    const findings = lintAll(loadContext(p, enabled, at(60), fakePorts().sessions)).active.filter((finding) => finding.rule === 'A-NUDGE-IGNORED')
    assert.deepEqual(findings.map((finding) => finding.subject), ['SWE1'])
  })

  it('促しの記録に、そのときの作業の印 (ボードの印と gh の印) を残す', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: '作業中', assignee: 'SWE1' })]))
    dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec, () => 'comments=3'))
    assert.deepEqual(readDispatches(p)[0]?.progress, { board: '作業中|なし|SWE1|', github: 'comments=3' })
  })

  it('促しの後に、gh の印 (PR の先頭のコミットなど) が変われば、進んでいる間は促さず、idleMinutes たって進まなければ、数え直して促す', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: '作業中', assignee: 'SWE1' })]))
    let token = 'a'
    const probe = (): string => token
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', at(0), dispatchPorts(enabled, exec, probe)), null)
    busyThenIdle(1, 2)
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', at(12), dispatchPorts(enabled, exec, probe)), null)
    token = 'b'
    busyThenIdle(13, 14)
    assert.equal(dispatchStep(p, enabled, 'SWE1', at(24), dispatchPorts(enabled, exec, probe)), null)
    assert.equal(dispatchStep(p, enabled, 'SWE1', at(30), dispatchPorts(enabled, exec, probe)), null)
    busyThenIdle(31, 32)
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', at(42), dispatchPorts(enabled, exec, probe)), null)
    assert.deepEqual(readDispatches(p).map((record) => record.progress?.github), ['a', 'a', 'b'])
  })

  it('進んでいる部下 (コメントが増え続ける) には、促しを続けない。進んだ時刻から idleMinutes たって、進まなければ促す', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: '作業中', assignee: 'SWE1' })]))
    let comments = 1
    const probe = (): string => `comments=${comments}`
    const results: boolean[] = []
    for (let minute = 0; minute <= 60; minute += 12) {
      if (minute > 0) busyThenIdle(minute - 11, minute - 10)
      comments += 1
      results.push(dispatchStep(p, enabled, 'SWE1', at(minute), dispatchPorts(enabled, exec, probe)) !== null)
    }
    assert.deepEqual(results, [true, false, false, false, false, false])
    busyThenIdle(61, 62)
    assert.equal(dispatchStep(p, enabled, 'SWE1', at(72), dispatchPorts(enabled, exec, probe)) !== null, true)
    assert.equal(readDispatches(p).length, 2)
  })

  it('見た印は、促したときと、進んでいて促さなかったときに残す。進んでいなければ、前の時刻のまま', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: '作業中', assignee: 'SWE1' })]))
    let token = 'a'
    const probe = (): string => token
    dispatchStep(p, enabled, 'SWE1', at(0), dispatchPorts(enabled, exec, probe))
    assert.deepEqual(readSeen(p)['SWE1|app#240'], { token: { board: '作業中|なし|SWE1|', github: 'a' }, at: at(0).toISOString() })
    token = 'b'
    busyThenIdle(11, 12)
    dispatchStep(p, enabled, 'SWE1', at(22), dispatchPorts(enabled, exec, probe))
    assert.deepEqual(readSeen(p)['SWE1|app#240'], { token: { board: '作業中|なし|SWE1|', github: 'b' }, at: at(22).toISOString() })
    busyThenIdle(23, 24)
    dispatchStep(p, enabled, 'SWE1', at(34), dispatchPorts(enabled, exec, probe))
    assert.equal(readSeen(p)['SWE1|app#240']?.at, at(22).toISOString())
  })

  it('2 回目の促しの後に、gh の印だけが進んだとき、促しの判断と A-NUDGE-IGNORED が同じ印で、どちらも進んだと見る', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: '作業中', assignee: 'SWE1' })]))
    let token = 'a'
    const probe = (): string => token
    dispatchStep(p, enabled, 'SWE1', at(0), dispatchPorts(enabled, exec, probe))
    busyThenIdle(1, 2)
    dispatchStep(p, enabled, 'SWE1', at(12), dispatchPorts(enabled, exec, probe))
    const ignored = () => lintAll(loadContext(p, enabled, at(30), fakePorts().sessions)).active.filter((finding) => finding.rule === 'A-NUDGE-IGNORED')
    assert.equal(ignored().length, 1)
    token = 'b'
    busyThenIdle(13, 14)
    assert.equal(dispatchStep(p, enabled, 'SWE1', at(24), dispatchPorts(enabled, exec, probe)), null)
    assert.equal(ignored().length, 0)
  })

  it('除く作者の作業中も数えて、作業中が上限なら、次の issue を渡さない (書き込みの守りと同じ数え方)', () => {
    idleSince('SWE1', 40)
    const others = Array.from({ length: enabled.wipLimit }, (_, index) => issue(100 + index, { status: '作業中', assignee: 'SWE2', author: 'external-dev' }))
    saveSnapshot(p, snapshot([...others, issue(11, { status: '次にやる' })]))
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec, noGithub)), null)
    assert.deepEqual(calls, [])
  })
})
