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

const enabled = { ...config, dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], utcOffset: '+09:00', notes: ['Tonight rule'] } }
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
  it('hands the chosen issue to a member who has stayed idle, writes the assignee and Status, updates the record and the board copy, and returns the message', () => {
    idleSince('SWE1', 20)
    saveSnapshot(p, snapshot([issue(11, { status: 'Next', title: 'Next job' }), issue(12, { status: 'Next' })]))
    const outcome = dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec))
    assert.deepEqual(calls, [
      ['set-assignee', ['11', 'SWE1']],
      ['set-status', ['11', 'In Progress']],
    ])
    assert.match(outcome?.message ?? '', /^scrum-harness: handed the next work to SWE1\.\napp#11 Next job\n/)
    assert.deepEqual(readDispatches(p).map((record) => `${record.member} ${record.label}`), ['SWE1 app#11'])
    const item = loadSnapshot(p)?.items.find((one) => one.number === 11)
    assert.deepEqual([item?.status, item?.assignee], ['In Progress', 'SWE1'])
    assert.match(readFileSync(p.events, 'utf8'), /"type":"dispatched"/)
  })

  it('does not rewrite the assignee when it is already that person', () => {
    idleSince('SWE1', 20)
    saveSnapshot(p, snapshot([issue(11, { status: 'Next', assignee: 'SWE1' })]))
    dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec))
    assert.deepEqual(calls, [['set-status', ['11', 'In Progress']]])
  })

  it('does not hand over again when the person is still not moving after a hand-over', () => {
    idleSince('SWE1', 20)
    saveSnapshot(p, snapshot([issue(11, { status: 'Next' }), issue(12, { status: 'Next' })]))
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    calls = []
    assert.equal(dispatchStep(p, enabled, 'SWE1', new Date(NOW.getTime() + 60_000), dispatchPorts(enabled, exec)), null)
    assert.deepEqual(calls, [])
  })

  it("does not give one issue to 2 people (the board copy is already In Progress because of the first person's hand-over)", () => {
    idleSince('SWE1', 20)
    idleSince('SWE2', 20)
    saveSnapshot(p, snapshot([issue(11, { status: 'Next' })]))
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    calls = []
    assert.equal(dispatchStep(p, enabled, 'SWE2', NOW, dispatchPorts(enabled, exec)), null)
    assert.deepEqual(calls, [])
  })

  it('does nothing when the member is not idle, the idle time is short, dispatch is disabled, or no script exists', () => {
    saveSnapshot(p, snapshot([issue(11, { status: 'Next' })]))
    writeHeartbeat(p, { sessionId: 'session-SWE1', name: 'SWE1', pid: null }, 'busy', minutesAgo(30))
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    idleSince('SWE2', 5)
    assert.equal(dispatchStep(p, enabled, 'SWE2', NOW, dispatchPorts(enabled, exec)), null)
    idleSince('SWE3', 20)
    assert.equal(dispatchStep(p, config, 'SWE3', NOW, dispatchPorts(config, exec)), null)
    assert.equal(dispatchStep(p, { ...enabled, scripts: {} }, 'SWE3', NOW, dispatchPorts({ ...enabled, scripts: {} }, exec)), null)
    assert.deepEqual(calls, [])
  })

  it('does not hand over to a person with a valid acknowledgement', () => {
    idleSince('SWE1', 20)
    saveSnapshot(p, snapshot([issue(11, { status: 'Next' })]))
    const ack: Ack = { rule: 'T-IDLE', subject: 'SWE1', until: new Date(NOW.getTime() + 600_000).toISOString(), reason: "Waiting for the owner's answer", at: NOW.toISOString() }
    writeJson(p.acks, addAck([], ack, NOW))
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    assert.deepEqual(calls, [])
  })

  it('does nothing when there is nothing to hand over', () => {
    idleSince('SWE1', 20)
    saveSnapshot(p, snapshot([issue(11, { status: 'Backlog' })]))
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    assert.deepEqual(calls, [])
    assert.deepEqual(readDispatches(p), [])
  })

  it('does not hand over while another process holds the lock', () => {
    idleSince('SWE1', 20)
    saveSnapshot(p, snapshot([issue(11, { status: 'Next' })]))
    writeFileSync(p.dispatchLock, String(process.ppid))
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec)), null)
    assert.deepEqual(calls, [])
  })

  it('when the script fails, writes neither the record nor the board copy, and does not retry for 5 minutes; tries again afterwards', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(11, { status: 'Next' })]))
    const failing: Exec = (script, args) => {
      calls.push([script, args])
      throw new Error('gh crashed')
    }
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, failing)), null)
    assert.deepEqual(readDispatches(p), [])
    assert.equal(loadSnapshot(p)?.items[0]?.status, 'Next')
    assert.match(readFileSync(p.errors, 'utf8'), /dispatch: gh crashed/)
    assert.ok(readJson<string | null>(p.dispatchFailure, null) !== null)
    calls = []
    assert.equal(dispatchStep(p, enabled, 'SWE1', new Date(NOW.getTime() + 4 * 60_000), dispatchPorts(enabled, exec)), null)
    assert.deepEqual(calls, [])
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', new Date(NOW.getTime() + 6 * 60_000), dispatchPorts(enabled, exec)), null)
  })
})

describe('nudges of dispatchStep', () => {
  const later = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000)
  const noGithub = (): null => null

  it('when the member has own In Progress work that is not stalled, does not hand over a new issue and nudges them to move forward without rewriting the board', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1', title: 'Ongoing job' }), issue(11, { status: 'Next' })]))
    const outcome = dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec, noGithub))
    assert.match(outcome?.message ?? '', /^scrum-harness: SWE1 is idle\. Continue app#240 Ongoing job, which is In Progress\./)
    assert.deepEqual(calls, [])
    assert.deepEqual(readDispatches(p).map((record) => `${record.kind} ${record.label}`), ['nudge app#240'])
    assert.equal(loadSnapshot(p)?.items.find((one) => one.number === 11)?.status, 'Next')
    assert.match(readFileSync(p.events, 'utf8'), /"type":"nudged","count":1/)
  })

  it('sends a nudge every idleMinutes, up to 2 times; the third is not sent', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })]))
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec, noGithub)), null)
    assert.equal(dispatchStep(p, enabled, 'SWE1', later(5), dispatchPorts(enabled, exec, noGithub)), null)
    assert.notEqual(dispatchStep(p, enabled, 'SWE1', later(11), dispatchPorts(enabled, exec, noGithub)), null)
    assert.equal(dispatchStep(p, enabled, 'SWE1', later(30), dispatchPorts(enabled, exec, noGithub)), null)
    assert.deepEqual(readDispatches(p).map((record) => record.kind), ['nudge', 'nudge'])
    assert.deepEqual(calls, [])
  })

  it('when the In Progress work is stalled, hands over the next issue instead of nudging', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1', reason: 'External wait' }), issue(11, { status: 'Next' })]))
    const outcome = dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec))
    assert.match(outcome?.message ?? '', /handed the next work to SWE1\.\napp#11/)
    assert.equal(calls.length, 2)
  })
})

describe('how dispatchStep counts nudges', () => {
  const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000)
  const noGithub = (): null => null
  const busyThenIdle = (busyAt: number, idleAt: number): void => {
    const who = { sessionId: 'session-SWE1', name: 'SWE1', pid: null }
    writeHeartbeat(p, who, 'busy', at(busyAt))
    writeHeartbeat(p, who, 'idle', at(idleAt))
  }

  it('even if the member keeps returning to idle in a short 1-turn run after a nudge, stops after 2 nudges when work does not progress, and A-NUDGE-IGNORED is emitted', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })]))
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

  it('keeps the work marker at that time (the board marker and the gh marker) in the nudge record', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })]))
    dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec, () => 'comments=3'))
    assert.deepEqual(readDispatches(p)[0]?.progress, { board: 'In Progress|None|SWE1|', github: 'comments=3' })
  })

  it("when the gh marker (such as the PR's head commit) changes after a nudge, does not nudge while progressing; once idleMinutes pass without progress, restarts counting and nudges", () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })]))
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

  it('does not keep nudging a member who is progressing (comments keep increasing); nudges once idleMinutes pass from the time of progress without more progress', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })]))
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

  it('the marker seen is kept when nudging and when not nudging because of progress; when there is no progress, the earlier time stays', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })]))
    let token = 'a'
    const probe = (): string => token
    dispatchStep(p, enabled, 'SWE1', at(0), dispatchPorts(enabled, exec, probe))
    assert.deepEqual(readSeen(p)['SWE1|app#240'], { token: { board: 'In Progress|None|SWE1|', github: 'a' }, at: at(0).toISOString() })
    token = 'b'
    busyThenIdle(11, 12)
    dispatchStep(p, enabled, 'SWE1', at(22), dispatchPorts(enabled, exec, probe))
    assert.deepEqual(readSeen(p)['SWE1|app#240'], { token: { board: 'In Progress|None|SWE1|', github: 'b' }, at: at(22).toISOString() })
    busyThenIdle(23, 24)
    dispatchStep(p, enabled, 'SWE1', at(34), dispatchPorts(enabled, exec, probe))
    assert.equal(readSeen(p)['SWE1|app#240']?.at, at(22).toISOString())
  })

  it('when only the gh marker progressed after the second nudge, the nudge decision and A-NUDGE-IGNORED use the same marker and both see progress', () => {
    idleSince('SWE1', 40)
    saveSnapshot(p, snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })]))
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

  it('counts the In Progress of excluded authors too, and when In Progress is at the limit, does not hand over the next issue (the same counting as the write guard)', () => {
    idleSince('SWE1', 40)
    const others = Array.from({ length: enabled.wipLimit }, (_, index) => issue(100 + index, { status: 'In Progress', assignee: 'SWE2', author: 'external-dev' }))
    saveSnapshot(p, snapshot([...others, issue(11, { status: 'Next' })]))
    assert.equal(dispatchStep(p, enabled, 'SWE1', NOW, dispatchPorts(enabled, exec, noGithub)), null)
    assert.deepEqual(calls, [])
  })
})
