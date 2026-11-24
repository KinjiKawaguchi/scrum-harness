import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { alertStep } from '../src/alerts/run.ts'
import { readAlertState } from '../src/alerts/state.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import type { Ack } from '../src/findings/acks.ts'
import { lintAll, loadContext } from '../src/findings/lint.ts'
import { paths, writeJson, type Paths } from '../src/store.ts'
import { writeHeartbeat } from '../src/team/heartbeat.ts'
import type { ActivityState } from '../src/team/types.ts'
import { issue, NOW, snapshot } from './helpers.ts'
import { child, enabled, epic, minutesLater } from './alerts-fixtures.ts'
import { fakePorts } from './fake-ports.ts'

const sessions = fakePorts().sessions

let p: Paths
let sent: (readonly [string, string])[]
const notify = (title: string, body: string): void => {
  sent.push([title, body])
}
const stalledBoard = () => snapshot([epic(), child(101, { status: 'Next' })])
const movingBoard = () => snapshot([epic(), child(101, { status: 'In Progress', assignee: 'SWE1' })])

function heartbeat(name: string, state: ActivityState, at: Date): void {
  writeHeartbeat(p, { sessionId: `session-${name}`, name, pid: null }, state, at)
}
const step = (now: Date, isLiaison = false, config = enabled) => alertStep(p, config, now, { notify, sessions, isLiaison })
const kinds = (notices: readonly { readonly kind: string }[]) => notices.map((notice) => notice.kind)

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-alerts-')))
  sent = []
  saveSnapshot(p, stalledBoard())
  heartbeat('SWE1', 'idle', minutesLater(-20))
})

describe('alertStep', () => {
  it('alerts が有効でなければ、何も書かず、何も出さない', () => {
    assert.deepEqual(step(NOW, true, { ...enabled, alerts: undefined }), [])
    assert.equal(existsSync(p.alertsState), false)
  })

  it('ボードの控えが無ければ、何もしない', () => {
    rmSync(p.snapshot)
    assert.deepEqual(step(NOW, true), [])
    assert.equal(existsSync(p.alertsState), false)
  })

  it('最初に見た時刻を書き、60 分に達した回に、macOS の通知を 1 度だけ出す', () => {
    step(NOW)
    assert.deepEqual(readAlertState(p).epics, { 'app#100': NOW.toISOString() })
    step(minutesLater(59))
    assert.equal(sent.length, 0)
    step(minutesLater(60))
    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.[0], 'scrum-harness')
    assert.match(sent[0]?.[1] ?? '', /^Nobody has been moving Epic app#100 "Epic 100" for 60 minutes\.$/)
    step(minutesLater(61))
    step(minutesLater(90))
    assert.equal(sent.length, 1)
  })

  it('isDesktopEnabled が false なら、macOS の通知は出さない', () => {
    const quiet = { ...enabled, alerts: { ...enabled.alerts!, isDesktopEnabled: false } }
    step(NOW, false, quiet)
    step(minutesLater(61), false, quiet)
    assert.equal(sent.length, 0)
  })

  it('macOS の通知が失敗したら、エラーを記録し、同じ通知で重ねて試さない', () => {
    let attempts = 0
    const failing = () => {
      attempts += 1
      throw new Error('osascript failed')
    }
    alertStep(p, enabled, NOW, { notify: failing, sessions, isLiaison: false })
    alertStep(p, enabled, minutesLater(60), { notify: failing, sessions, isLiaison: false })
    alertStep(p, enabled, minutesLater(61), { notify: failing, sessions, isLiaison: false })
    assert.equal(attempts, 1)
    assert.match(readFileSync(p.errors, 'utf8'), /alert-desktop: osascript failed/)
  })

  it('窓口の待機のときだけ、窓口にまだ送っていない通知を返し、送った通知は重ねて返さない', () => {
    step(NOW)
    assert.deepEqual(step(minutesLater(60), false), [])
    const first = step(minutesLater(60), true)
    assert.deepEqual(kinds(first), ['owner', 'idle-line'])
    assert.match(first[0]?.text ?? '', /E-STALL app#100: send the owner one PushNotification/)
    assert.deepEqual(step(minutesLater(61), true), [])
    assert.match(readFileSync(p.events, 'utf8'), /"type":"alert-liaison","key":"E-STALL:app#100:/)
  })

  it('TechLead が E-STALL を受け入れたら、オーナーへの通知も macOS の通知も出さない (空きの 1 行は出る)', () => {
    const ack: Ack = { rule: 'E-STALL', subject: 'app#100', until: minutesLater(120).toISOString(), reason: 'Intended wait', at: NOW.toISOString() }
    writeJson(p.acks, [ack])
    step(NOW)
    assert.deepEqual(kinds(step(minutesLater(60), true)), ['idle-line'])
    assert.equal(sent.length, 0)
  })

  it('動き出してから止まり直した同じ Epic は、直前の通知から 24 時間のうちは、オーナーへ通知しない。窓口には 1 行で伝える', () => {
    step(NOW)
    step(minutesLater(60))
    assert.equal(sent.length, 1)
    assert.deepEqual(Object.keys(readAlertState(p).ownerPushedAt), ['epic:app#100'])
    saveSnapshot(p, movingBoard())
    heartbeat('SWE1', 'busy', minutesLater(65))
    step(minutesLater(66))
    assert.deepEqual(readAlertState(p).epics, {})
    assert.deepEqual(readAlertState(p).desktopSent, [])
    saveSnapshot(p, stalledBoard())
    heartbeat('SWE1', 'idle', minutesLater(70))
    step(minutesLater(100))
    const held = step(minutesLater(160), true)
    assert.equal(sent.length, 1)
    assert.deepEqual(kinds(held).filter((kind) => kind !== 'idle-line'), ['info'])
    assert.match(held.find((notice) => notice.kind === 'info')?.text ?? '', /the owner was already notified at 16:00, and the same subject is sent at most once per 24 h, so it is not sent this time/)
    assert.equal(step(minutesLater(161), true).length, 0)
  })

  it('通知から 24 時間たっても止まったままなら、そのときの新しい通知として、オーナーにまた出す', () => {
    step(NOW)
    step(minutesLater(60))
    saveSnapshot(p, movingBoard())
    heartbeat('SWE1', 'busy', minutesLater(65))
    step(minutesLater(66))
    saveSnapshot(p, stalledBoard())
    heartbeat('SWE1', 'idle', minutesLater(70))
    step(minutesLater(100))
    step(minutesLater(160))
    assert.equal(sent.length, 1)
    step(minutesLater(60 + 24 * 60 - 1))
    assert.equal(sent.length, 1)
    step(minutesLater(60 + 24 * 60))
    assert.equal(sent.length, 2)
    assert.deepEqual(Object.keys(readAlertState(p).ownerPushedAt), ['epic:app#100'])
  })

  it('間隔は Epic ごと。別の Epic の通知は止めず、同じ評価で出た 2 つの Epic は、macOS の通知 1 つにまとまる', () => {
    const two = snapshot([epic(), child(101, { status: 'Next' }), issue(200, { title: 'Epic 200' }), child(201, { status: 'Next', epic: 'app#200' })])
    saveSnapshot(p, two)
    step(NOW)
    step(minutesLater(60))
    assert.equal(sent.length, 1)
    assert.match(sent[0]?.[1] ?? '', /^There are 2 stalls\.\n- nobody is moving app#100 "Epic 100" for 60 minutes \(no children In Progress \(Next 1, Backlog 0\)\)\n- nobody is moving app#200 "Epic 200"/)
    assert.deepEqual(Object.keys(readAlertState(p).ownerPushedAt).toSorted(), ['epic:app#100', 'epic:app#200'])
    assert.equal(readAlertState(p).desktopSent.filter((key) => key.startsWith('E-STALL')).length, 2)
    step(minutesLater(61))
    assert.equal(sent.length, 1)
  })

  it('夜の間に止まった 4 つの Epic が、同じ評価で一度に E-STALL になっても、窓口への通知は 1 通で、1 行ずつ、止まっている理由が付く', () => {
    const epics = [100, 200, 300, 400].flatMap((number, index) => [
      issue(number, { title: `Epic ${number}`, labels: [] }),
      child(number + 1, { status: index === 0 ? 'In Progress' : 'Next', assignee: index === 0 ? 'SWE1' : null, reason: index === 0 ? 'Needs decision' : 'None', epic: `app#${number}` }),
    ])
    saveSnapshot(p, snapshot(epics))
    step(NOW)
    const owner = step(minutesLater(60), true).filter((notice) => notice.kind === 'owner')
    assert.equal(owner.length, 1)
    assert.match(owner[0]?.text ?? '', /4 stalls: send the owner one PushNotification/)
    assert.match(owner[0]?.text ?? '', /nobody is moving app#100 "Epic 100" for 60 minutes \(waiting for the owner's answer \(app#101\)\)/)
    assert.match(owner[0]?.text ?? '', /add one line with the pending question \(subjects: app#101\)/)
    assert.equal(sent.length, 1)
    assert.equal(step(minutesLater(61), true).filter((notice) => notice.kind === 'owner').length, 0)
    assert.equal(sent.length, 1)
  })

  it('通知を出していない (macOS の通知も窓口の待機も無い) うちは、通知した時刻を覚えない', () => {
    const quiet = { ...enabled, alerts: { ...enabled.alerts!, isDesktopEnabled: false } }
    step(NOW, false, quiet)
    step(minutesLater(60), false, quiet)
    assert.deepEqual(readAlertState(p).ownerPushedAt, {})
    step(minutesLater(61), true, quiet)
    assert.deepEqual(Object.keys(readAlertState(p).ownerPushedAt), ['epic:app#100'])
  })

  it('渡せる issue が無い部下は、30 分たったところで、オーナーへの macOS の通知を出す。それまでは TechLead への指摘だけ', () => {
    saveSnapshot(p, snapshot([]))
    step(NOW)
    assert.deepEqual(readAlertState(p).empty, { 'SWE1:no-candidate': NOW.toISOString() })
    step(minutesLater(29))
    assert.equal(sent.length, 0)
    assert.deepEqual(lintAll(loadContext(p, enabled, minutesLater(29), sessions)).active.map((one) => one.rule).filter((rule) => rule.startsWith('Q-')), ['Q-EMPTY'])
    step(minutesLater(30))
    assert.equal(sent.length, 1)
    assert.match(sent[0]?.[1] ?? '', /^30 minutes have passed with no issue to hand over to SWE1/)
    assert.deepEqual(lintAll(loadContext(p, enabled, minutesLater(30), sessions)).active.map((one) => one.rule).filter((rule) => rule.startsWith('Q-')).toSorted(), ['Q-EMPTY', 'Q-EMPTY-OWNER'])
  })

  it('渡せる issue が尽きた部下のオーナーへの通知は、同じ人について 60 分に 1 回まで。間隔が過ぎれば、また出る', () => {
    saveSnapshot(p, snapshot([]))
    step(NOW)
    step(minutesLater(30))
    assert.equal(sent.length, 1)
    assert.match(sent[0]?.[1] ?? '', /^30 minutes have passed with no issue to hand over to SWE1/)
    saveSnapshot(p, snapshot([issue(1, { status: 'Next' })]))
    step(minutesLater(31))
    saveSnapshot(p, snapshot([]))
    step(minutesLater(40))
    const held = step(minutesLater(70), true).filter((notice) => notice.kind === 'info')
    assert.equal(sent.length, 1)
    assert.equal(held.length, 1)
    assert.match(held[0]?.text ?? '', /the same subject is sent at most once per 1 h, so it is not sent this time/)
    step(minutesLater(90))
    assert.equal(sent.length, 2)
  })

  it('作業中が上限で渡せない部下は、30 分を過ぎても、オーナーへ通知しない (TechLead の Q-EMPTY だけ)', () => {
    const tight = { ...enabled, wipLimit: 1 }
    saveSnapshot(p, snapshot([issue(1, { status: 'In Progress', assignee: 'SWE2' }), issue(2, { status: 'Next' })]))
    step(NOW, false, tight)
    step(minutesLater(45), false, tight)
    assert.equal(sent.length, 0)
    const rules = lintAll(loadContext(p, tight, minutesLater(45), sessions)).active.map((finding) => finding.rule)
    assert.ok(rules.includes('Q-EMPTY'))
    assert.ok(!rules.includes('Q-EMPTY-OWNER'))
  })

  it('錠を別の生きているプロセスが持っていれば、何もしない', () => {
    mkdirSync(dirname(p.alertsLock), { recursive: true })
    writeFileSync(p.alertsLock, String(process.ppid))
    assert.deepEqual(step(minutesLater(60), true), [])
    assert.equal(existsSync(p.alertsState), false)
  })

  it('終わったら錠を返す', () => {
    step(NOW)
    assert.equal(existsSync(p.alertsLock), false)
  })
})

describe('lintAll への組み込み', () => {
  it('最初に見た時刻から 60 分たった Epic は、lint に E-STALL (高) で出る。alerts が無効なら出ない', () => {
    step(NOW)
    const now = minutesLater(60)
    const stall = lintAll(loadContext(p, enabled, now, sessions)).active.find((finding) => finding.rule === 'E-STALL')
    assert.deepEqual([stall?.subject, stall?.severity], ['app#100', 'high'])
    assert.equal(lintAll(loadContext(p, { ...enabled, alerts: undefined }, now, sessions)).active.some((finding) => finding.rule === 'E-STALL'), false)
  })

  it('受け入れた E-STALL は active から外れ、acked に入る', () => {
    step(NOW)
    const ack: Ack = { rule: 'E-STALL', subject: 'app#100', until: minutesLater(120).toISOString(), reason: 'Intended wait', at: NOW.toISOString() }
    writeJson(p.acks, [ack])
    const result = lintAll(loadContext(p, enabled, minutesLater(60), sessions))
    assert.equal(result.active.some((finding) => finding.rule === 'E-STALL'), false)
    assert.equal(result.acked.some((finding) => finding.rule === 'E-STALL'), true)
  })
})

describe('readAlertState', () => {
  it('無いか壊れているか形が違えば、何も見ていない状態から始める', () => {
    assert.deepEqual(readAlertState(p), { epics: {}, empty: {}, desktopSent: [], liaisonSent: [], ownerPushedAt: {} })
    mkdirSync(dirname(p.alertsState), { recursive: true })
    writeFileSync(p.alertsState, '{broken')
    assert.deepEqual(readAlertState(p).epics, {})
    writeJson(p.alertsState, { epics: { 'app#1': 5 }, empty: 'x', desktopSent: [1], liaisonSent: ['k'], ownerPushedAt: [] })
    assert.deepEqual(readAlertState(p), { epics: {}, empty: {}, desktopSent: [], liaisonSent: ['k'], ownerPushedAt: {} })
  })
})

describe('runLiaisonWatch', async () => {
  const { runLiaisonWatch } = await import('../src/alerts/liaison.ts')
  const options = { maxMs: 400, intervalMs: 10 }
  const freshBoard = () => ({ ...stalledBoard(), fetchedAt: new Date().toISOString() })

  it('窓口に送る通知があれば、その文を返し、錠を返す。送った通知は、次の待機では返さない', async () => {
    saveSnapshot(p, freshBoard())
    heartbeat('SWE2', 'idle', new Date(Date.now() - 20 * 60_000))
    const message = await runLiaisonWatch(p, enabled, 'Liaison', options, fakePorts({ notify }))
    assert.match(message ?? '', /^scrum-harness: notice for the liaison/)
    assert.match(message ?? '', /- SWE2 has been idle for 20 minutes\. Acknowledgement: none\. Harness action: nothing sent yet/)
    assert.equal(existsSync(p.memberWatchLock('Liaison')), false)
    assert.equal(await runLiaisonWatch(p, enabled, 'Liaison', { maxMs: 60, intervalMs: 10 }, fakePorts({ notify })), null)
  })

  it('同じ窓口の待機が動いていれば、重ねて動かない', async () => {
    saveSnapshot(p, freshBoard())
    heartbeat('SWE2', 'idle', new Date(Date.now() - 20 * 60_000))
    mkdirSync(dirname(p.memberWatchLock('Liaison')), { recursive: true })
    writeFileSync(p.memberWatchLock('Liaison'), String(process.ppid))
    assert.equal(await runLiaisonWatch(p, enabled, 'Liaison', options, fakePorts({ notify })), null)
  })
})
