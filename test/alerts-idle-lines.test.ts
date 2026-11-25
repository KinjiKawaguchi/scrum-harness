import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { idleLines } from '../src/alerts/idle-lines.ts'
import type { AlertInput } from '../src/alerts/rules.ts'
import type { DispatchRecord } from '../src/dispatch/types.ts'
import type { Ack } from '../src/findings/acks.ts'
import type { MemberState } from '../src/team/types.ts'
import { NOW, snapshot } from './helpers.ts'
import { busy, enabled, idle, minutesAgo, minutesLater, stateWith } from './alerts-fixtures.ts'

const input = (members: readonly MemberState[], overrides: Partial<AlertInput> = {}): AlertInput => ({
  snapshot: snapshot([]),
  members,
  acks: [],
  dispatches: [],
  alerts: stateWith({}),
  config: enabled,
  now: NOW,
  ...overrides,
})

describe('idleLines', () => {
  it('when a member has been idle for idleMinutes, creates one line for the liaison; attaches no macOS notification', () => {
    const [line, ...rest] = idleLines(input([idle('SWE1', 10)]))
    assert.equal(rest.length, 0)
    assert.equal(line?.kind, 'idle-line')
    assert.equal(line?.desktop, undefined)
    assert.equal(line?.text, '- SWE1 has been idle for 10 minutes. Acknowledgement: none. Harness action: nothing sent yet')
    assert.equal(line?.key, `idle-line:SWE1:${minutesAgo(10)}`)
  })

  it('does not emit for an idle time under idleMinutes, a person who is moving, or a person who is not a member (the TechLead)', () => {
    assert.deepEqual(idleLines(input([idle('SWE1', 9), busy('SWE2'), idle('TechLead', 30)])), [])
  })

  it("emits even with an acknowledgement, and writes the acknowledgement's reason and its end time (JST)", () => {
    const ack: Ack = { rule: 'T-IDLE', subject: 'SWE1', until: minutesLater(30).toISOString(), reason: "Waiting for the owner's answer", at: minutesAgo(5) }
    const [line] = idleLines(input([idle('SWE1', 15)], { acks: [ack] }))
    assert.match(line?.text ?? '', /Acknowledgement: Waiting for the owner's answer \(until 15:30\)/)
  })

  it("an expired acknowledgement and another person's acknowledgement are written as no acknowledgement", () => {
    const old: Ack = { rule: 'T-IDLE', subject: 'SWE1', until: minutesAgo(1), reason: "Waiting for the owner's answer", at: minutesAgo(50) }
    const other: Ack = { ...old, subject: 'SWE2', until: minutesLater(30).toISOString() }
    assert.match(idleLines(input([idle('SWE1', 15)], { acks: [old, other] }))[0]?.text ?? '', /Acknowledgement: none/)
  })

  it('writes the last hand-over and nudge made during the idle period with their time; does not write those from before the idle period', () => {
    const before: DispatchRecord = { at: minutesAgo(30), member: 'SWE1', label: 'app#5', title: 'x' }
    const given: DispatchRecord = { at: minutesAgo(8), member: 'SWE1', label: 'app#11', title: 'y' }
    const nudge: DispatchRecord = { kind: 'nudge', at: minutesAgo(2), member: 'SWE1', label: 'app#12', title: 'z' }
    const members = [idle('SWE1', 15)]
    assert.match(idleLines(input(members, { dispatches: [before] }))[0]?.text ?? '', /nothing sent yet/)
    assert.match(idleLines(input(members, { dispatches: [before, given] }))[0]?.text ?? '', /handed over app#11 \(14:52\)/)
    assert.match(idleLines(input(members, { dispatches: [before, given, nudge] }))[0]?.text ?? '', /nudged app#12 \(14:58\)/)
  })

  it('a member detected as having no issue to hand over is written as such', () => {
    const line = idleLines(input([idle('SWE1', 15)], { alerts: stateWith({ empty: { 'SWE1:no-candidate': minutesAgo(5) } }) }))[0]
    assert.match(line?.text ?? '', /Harness action: no issue to hand over$/)
  })

  it('the fingerprint changes when the idle period changes (it is emitted again for someone who became idle again)', () => {
    assert.notEqual(idleLines(input([idle('SWE1', 15)]))[0]?.key, idleLines(input([idle('SWE1', 12)]))[0]?.key)
  })
})
