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
  it('when alerts is not enabled, writes nothing and emits nothing', () => {
    assert.deepEqual(step(NOW, true, { ...enabled, alerts: undefined }), [])
    assert.equal(existsSync(p.alertsState), false)
  })

  it('does nothing when there is no board copy', () => {
    rmSync(p.snapshot)
    assert.deepEqual(step(NOW, true), [])
    assert.equal(existsSync(p.alertsState), false)
  })

  it('writes the first-seen time and emits the desktop notification only once, on the run that reaches 60 minutes', () => {
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

  it('does not emit the desktop notification when isDesktopEnabled is false', () => {
    const quiet = { ...enabled, alerts: { ...enabled.alerts!, isDesktopEnabled: false } }
    step(NOW, false, quiet)
    step(minutesLater(61), false, quiet)
    assert.equal(sent.length, 0)
  })

  it('when the desktop notification fails, records the error and does not retry for the same notification', () => {
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

  it('only in a liaison watch, returns notifications not yet sent to the liaison, and does not return sent ones again', () => {
    step(NOW)
    assert.deepEqual(step(minutesLater(60), false), [])
    const first = step(minutesLater(60), true)
    assert.deepEqual(kinds(first), ['owner', 'idle-line'])
    assert.match(first[0]?.text ?? '', /E-STALL app#100: send the owner one PushNotification/)
    assert.deepEqual(step(minutesLater(61), true), [])
    assert.match(readFileSync(p.events, 'utf8'), /"type":"alert-liaison","key":"E-STALL:app#100:/)
  })

  it('when the TechLead acknowledges E-STALL, emits neither the owner notification nor the desktop notification (the idle line still appears)', () => {
    const ack: Ack = { rule: 'E-STALL', subject: 'app#100', until: minutesLater(120).toISOString(), reason: 'Intended wait', at: NOW.toISOString() }
    writeJson(p.acks, [ack])
    step(NOW)
    assert.deepEqual(kinds(step(minutesLater(60), true)), ['idle-line'])
    assert.equal(sent.length, 0)
  })

  it('the same Epic that stalls again after starting to move does not notify the owner within 24 hours of the previous notification; the liaison is told in one line', () => {
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

  it('if still stalled 24 hours after the notification, notifies the owner again as a new notification at that time', () => {
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

  it("the interval is per Epic; it does not hold back another Epic's notification, and two Epics found in the same evaluation are merged into one desktop notification", () => {
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

  it('when 4 Epics that stopped during the night all become E-STALL in the same evaluation, the liaison gets one notification with one line per Epic, each with its stall reason', () => {
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

  it('does not remember the notification time while nothing is emitted (neither a desktop notification nor a liaison watch exists)', () => {
    const quiet = { ...enabled, alerts: { ...enabled.alerts!, isDesktopEnabled: false } }
    step(NOW, false, quiet)
    step(minutesLater(60), false, quiet)
    assert.deepEqual(readAlertState(p).ownerPushedAt, {})
    step(minutesLater(61), true, quiet)
    assert.deepEqual(Object.keys(readAlertState(p).ownerPushedAt), ['epic:app#100'])
  })

  it('for a member with no issue to hand over, emits the owner desktop notification at 30 minutes; until then only the finding for the TechLead', () => {
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

  it('the owner notification for a member whose issues to hand over ran out goes at most once per 60 minutes for the same person; once the interval passes, it is emitted again', () => {
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

  it("a member who cannot be handed work because In Progress is at the limit does not notify the owner even past 30 minutes (only the TechLead's Q-EMPTY)", () => {
    const tight = { ...enabled, wipLimit: 1 }
    saveSnapshot(p, snapshot([issue(1, { status: 'In Progress', assignee: 'SWE2' }), issue(2, { status: 'Next' })]))
    step(NOW, false, tight)
    step(minutesLater(45), false, tight)
    assert.equal(sent.length, 0)
    const rules = lintAll(loadContext(p, tight, minutesLater(45), sessions)).active.map((finding) => finding.rule)
    assert.ok(rules.includes('Q-EMPTY'))
    assert.ok(!rules.includes('Q-EMPTY-OWNER'))
  })

  it('does nothing when another live process holds the lock', () => {
    mkdirSync(dirname(p.alertsLock), { recursive: true })
    writeFileSync(p.alertsLock, String(process.ppid))
    assert.deepEqual(step(minutesLater(60), true), [])
    assert.equal(existsSync(p.alertsState), false)
  })

  it('releases the lock when finished', () => {
    step(NOW)
    assert.equal(existsSync(p.alertsLock), false)
  })
})

describe('integration into lintAll', () => {
  it('an Epic 60 minutes past its first-seen time appears in lint as E-STALL (high); it does not appear when alerts is disabled', () => {
    step(NOW)
    const now = minutesLater(60)
    const stall = lintAll(loadContext(p, enabled, now, sessions)).active.find((finding) => finding.rule === 'E-STALL')
    assert.deepEqual([stall?.subject, stall?.severity], ['app#100', 'high'])
    assert.equal(lintAll(loadContext(p, { ...enabled, alerts: undefined }, now, sessions)).active.some((finding) => finding.rule === 'E-STALL'), false)
  })

  it('an acknowledged E-STALL leaves active and goes into acked', () => {
    step(NOW)
    const ack: Ack = { rule: 'E-STALL', subject: 'app#100', until: minutesLater(120).toISOString(), reason: 'Intended wait', at: NOW.toISOString() }
    writeJson(p.acks, [ack])
    const result = lintAll(loadContext(p, enabled, minutesLater(60), sessions))
    assert.equal(result.active.some((finding) => finding.rule === 'E-STALL'), false)
    assert.equal(result.acked.some((finding) => finding.rule === 'E-STALL'), true)
  })
})

describe('readAlertState', () => {
  it('starts from a state where nothing has been seen if the file is missing, broken, or in the wrong shape', () => {
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

  it('when there is a notification for the liaison, returns its message and releases the lock; the notification already sent is not returned in the next watch', async () => {
    saveSnapshot(p, freshBoard())
    heartbeat('SWE2', 'idle', new Date(Date.now() - 20 * 60_000))
    const message = await runLiaisonWatch(p, enabled, 'Liaison', options, fakePorts({ notify }))
    assert.match(message ?? '', /^scrum-harness: notice for the liaison/)
    assert.match(message ?? '', /- SWE2 has been idle for 20 minutes\. Acknowledgement: none\. Harness action: nothing sent yet/)
    assert.equal(existsSync(p.memberWatchLock('Liaison')), false)
    assert.equal(await runLiaisonWatch(p, enabled, 'Liaison', { maxMs: 60, intervalMs: 10 }, fakePorts({ notify })), null)
  })

  it('does not run twice when a watch of the same liaison is already running', async () => {
    saveSnapshot(p, freshBoard())
    heartbeat('SWE2', 'idle', new Date(Date.now() - 20 * 60_000))
    mkdirSync(dirname(p.memberWatchLock('Liaison')), { recursive: true })
    writeFileSync(p.memberWatchLock('Liaison'), String(process.ppid))
    assert.equal(await runLiaisonWatch(p, enabled, 'Liaison', options, fakePorts({ notify })), null)
  })
})
