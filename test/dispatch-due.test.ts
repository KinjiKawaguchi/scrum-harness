import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchDue } from '../src/dispatch/due.ts'
import { isValidIdleAck } from '../src/dispatch/idle-ack.ts'
import type { DispatchRecord } from '../src/dispatch/types.ts'
import type { Ack } from '../src/findings/acks.ts'
import type { MemberState } from '../src/team/types.ts'
import { config, NOW } from './helpers.ts'

const enabled = { ...config, dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], utcOffset: '+09:00', notes: [] } }
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const minutesLater = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString()

const idle = (minutes: number, name = 'SWE1'): MemberState => ({ name, state: 'idle', since: minutesAgo(minutes) })
const ack = (overrides: Partial<Ack> = {}): Ack => ({
  rule: 'T-IDLE',
  subject: 'SWE1',
  until: minutesLater(30),
  reason: "Waiting for the owner's answer",
  at: minutesAgo(10),
  ...overrides,
})
const record = (minutes: number, member = 'SWE1'): DispatchRecord => ({ at: minutesAgo(minutes), member, label: 'app#11', title: 'issue 11' })

describe('dispatchDue', () => {
  it('hands over when the idle time has lasted idleMinutes with neither an acknowledgement nor a hand-over record', () => {
    assert.deepEqual(dispatchDue(idle(10), [], [], enabled, NOW), { isDue: true })
  })

  it('does not hand over when dispatch is not configured or not enabled', () => {
    assert.deepEqual(dispatchDue(idle(30), [], [], config, NOW), { isDue: false, reason: 'disabled' })
    const off = { ...config, dispatch: { ...enabled.dispatch, enabled: false } }
    assert.deepEqual(dispatchDue(idle(30), [], [], off, NOW), { isDue: false, reason: 'disabled' })
  })

  it('does not hand over to a person who is not in the hand-over targets', () => {
    const only = { ...enabled, dispatch: { ...enabled.dispatch, members: ['SWE2'] } }
    assert.deepEqual(dispatchDue(idle(30), [], [], only, NOW), { isDue: false, reason: 'not-target' })
    assert.deepEqual(dispatchDue(idle(30, 'SWE2'), [], [], only, NOW), { isDue: true })
  })

  it('does not hand over to a person who is not idle or whose idle time is short', () => {
    assert.deepEqual(dispatchDue({ name: 'SWE1', state: 'busy', since: minutesAgo(30) }, [], [], enabled, NOW), { isDue: false, reason: 'not-idle' })
    assert.deepEqual(dispatchDue({ name: 'SWE1', state: 'unknown', since: null }, [], [], enabled, NOW), { isDue: false, reason: 'not-idle' })
    assert.deepEqual(dispatchDue(idle(9), [], [], enabled, NOW), { isDue: false, reason: 'too-short' })
  })

  it('does not hand over again when the person is still not moving after a hand-over (the idle time began before the hand-over)', () => {
    assert.deepEqual(dispatchDue(idle(30), [], [record(20)], enabled, NOW), { isDue: false, reason: 'already-dispatched' })
    assert.deepEqual(dispatchDue(idle(30), [], [record(40)], enabled, NOW), { isDue: true })
    assert.deepEqual(dispatchDue(idle(30), [], [record(20, 'SWE2')], enabled, NOW), { isDue: true })
  })

  it("does not hand over when a valid T-IDLE acknowledgement exists; expired ones, another person's, and those of another rule do not count", () => {
    assert.deepEqual(dispatchDue(idle(30), [ack()], [], enabled, NOW), { isDue: false, reason: 'accepted' })
    assert.deepEqual(dispatchDue(idle(30), [ack({ until: minutesAgo(1) })], [], enabled, NOW), { isDue: true })
    assert.deepEqual(dispatchDue(idle(30), [ack({ subject: 'SWE2' })], [], enabled, NOW), { isDue: true })
    assert.deepEqual(dispatchDue(idle(30), [ack({ rule: 'T-WAITING' })], [], enabled, NOW), { isDue: true })
  })

  it('an acknowledgement for a slot does not stop hand-over until 15 minutes before the slot starts, and stops it after that', () => {
    const slot = (minutes: number) => ack({ reason: 'slot 16:00', slotAt: minutesLater(minutes) })
    assert.deepEqual(dispatchDue(idle(30), [slot(16)], [], enabled, NOW), { isDue: true })
    assert.deepEqual(dispatchDue(idle(30), [slot(15)], [], enabled, NOW), { isDue: false, reason: 'accepted' })
    assert.deepEqual(dispatchDue(idle(30), [slot(-10)], [], enabled, NOW), { isDue: false, reason: 'accepted' })
  })
})

describe('idleGate and nudge records', () => {
  it('nudge records do not count in the decision whether to hand over a new issue (not handing over again)', async () => {
    const { idleGate } = await import('../src/dispatch/due.ts')
    const nudged: DispatchRecord = { kind: 'nudge', at: minutesAgo(5), member: 'SWE1', label: 'app#1', title: 't' }
    assert.deepEqual(dispatchDue(idle(30), [], [nudged], enabled, NOW), { isDue: true })
    assert.deepEqual(idleGate(idle(30), [], enabled, NOW), { isDue: true })
    assert.deepEqual(idleGate(idle(30), [ack()], enabled, NOW), { isDue: false, reason: 'accepted' })
  })
})

describe('validation of stored T-IDLE acknowledgements', () => {
  const old = (overrides: Partial<Ack> = {}) => ack({ at: minutesAgo(10), until: minutesLater(230), reason: 'low capacity', ...overrides })

  it('does not stop hand-over for an acknowledgement stored without having been validated (a long expiry, or a reason such as spare capacity)', () => {
    assert.deepEqual(dispatchDue(idle(30), [old()], [], enabled, NOW), { isDue: true })
    assert.deepEqual(dispatchDue(idle(30), [old({ reason: "Waiting for the owner's answer", until: minutesLater(230) })], [], enabled, NOW), { isDue: true })
  })

  it('does not stop for one with trailing text after the reason; stops for an exact match of the reason with an expiry within 1 hour', () => {
    assert.deepEqual(dispatchDue(idle(30), [ack({ reason: "Waiting for the owner's answer, low capacity" })], [], enabled, NOW), { isDue: true })
    assert.deepEqual(dispatchDue(idle(30), [ack({ reason: "Waiting for the owner's answer" })], [], enabled, NOW), { isDue: false, reason: 'accepted' })
  })

  it('does not stop for a slot reason that lacks the slot start (slotAt)', () => {
    assert.deepEqual(dispatchDue(idle(30), [ack({ reason: 'slot 16:00' })], [], enabled, NOW), { isDue: true })
  })
})

describe('isValidIdleAck', () => {
  const made = (overrides: Partial<Ack>): Ack => ack({ at: minutesAgo(0), until: minutesLater(60), ...overrides })

  it(`passes on an exact match of "Waiting for the owner's answer" with an expiry within 1 hour (exactly 1 hour passes too)`, () => {
    assert.equal(isValidIdleAck(made({ reason: "Waiting for the owner's answer" }), enabled), true)
    assert.equal(isValidIdleAck(made({ reason: "Waiting for the owner's answer", until: minutesLater(61) }), enabled), false)
  })

  it('does not pass when there is text before or after the reason', () => {
    assert.equal(isValidIdleAck(made({ reason: "Waiting for the owner's answer, low capacity" }), enabled), false)
    assert.equal(isValidIdleAck(made({ reason: "Long Waiting for the owner's answer" }), enabled), false)
  })

  it('"slot HH:MM" passes when the slot start is recorded and the shape matches exactly', () => {
    assert.equal(isValidIdleAck(made({ reason: 'slot 16:00', slotAt: minutesLater(30) }), enabled), true)
    assert.equal(isValidIdleAck(made({ reason: 'slot 16:00', slotAt: undefined }), enabled), false)
    assert.equal(isValidIdleAck(made({ reason: 'slot 16:00 until', slotAt: minutesLater(30) }), enabled), false)
  })

  it('does not pass when the expiry or creation time cannot be read; acknowledgements other than T-IDLE are not examined', () => {
    assert.equal(isValidIdleAck(made({ reason: "Waiting for the owner's answer", at: 'x' }), enabled), false)
    assert.equal(isValidIdleAck(made({ rule: 'B-WIP-OVER', reason: 'anything', until: minutesLater(5000) }), enabled), true)
  })
})
