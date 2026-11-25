import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkIdleAck, slotInstant } from '../src/dispatch/idle-ack.ts'
import { config, NOW } from './helpers.ts'

// NOW is 2026-10-08 15:00 JST
const check = (reason: string, durationMs = 3_600_000, now = NOW) => checkIdleAck({ reason, durationMs, now, config })

describe('checkIdleAck', () => {
  it(`accepts "Waiting for the owner's answer" for up to 1 hour and attaches no slot`, () => {
    assert.deepEqual(check("Waiting for the owner's answer"), { ok: true, slotAt: null })
  })

  it('does not accept a reason with trailing text added (no partial matching)', () => {
    assert.equal(check("Waiting for the owner's answer, low capacity").ok, false)
    assert.equal(check('slot 15:30 until').ok, false)
    assert.equal(check('slot 15:30, spare capacity').ok, false)
    assert.equal(check('Prefix slot 15:30').ok, false)
  })

  it('does not accept an expiry longer than 1 hour even if the reason is right', () => {
    const result = check("Waiting for the owner's answer", 3_600_001)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /at most 1 hour/)
  })

  it('accepts "slot HH:MM" and records the slot start', () => {
    assert.deepEqual(check('slot 15:30'), { ok: true, slotAt: '2026-10-08T06:30:00.000Z' })
    assert.deepEqual(check('slot 16:15'), { ok: true, slotAt: '2026-10-08T07:15:00.000Z' })
  })

  it('does not accept a slot that starts later than 1 hour 15 minutes from now (the expiry would pass before 15 minutes ahead of the slot)', () => {
    const result = check('slot 16:16')
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /within 1 hour 15 minutes/)
  })

  it('inside a slot (within 1 hour of its start), accepts it and keeps the start time', () => {
    assert.deepEqual(check('slot 14:30'), { ok: true, slotAt: '2026-10-08T05:30:00.000Z' })
  })

  it("treats a slot time that ended more than 1 hour ago as tomorrow's slot and does not accept it", () => {
    assert.equal(check('slot 08:00').ok, false)
  })

  it('a context-capacity reason is not allowed; nothing other than the fixed words is accepted', () => {
    const context = check('no spare context capacity')
    assert.equal(context.ok, false)
    assert.match(context.ok ? '' : context.message, /Spare context capacity cannot be a reason/)
    for (const reason of ['slot', 'slot 25:00', 'slot 9:30', 'Waiting for the night run', '']) assert.equal(check(reason).ok, false, reason)
  })
})

describe('slotInstant', () => {
  it("returns the instant of that time on the time-zone side's date (even when the UTC side crosses a date)", () => {
    const late = new Date('2026-10-08T15:30:00.000Z') // 10-09 00:30 JST
    assert.equal(slotInstant(late, 0, 45, '+09:00').toISOString(), '2026-10-08T15:45:00.000Z')
  })

  it('handles a negative offset too', () => {
    const now = new Date('2026-10-08T01:00:00.000Z') // 10-07 20:00 -05:00
    assert.equal(slotInstant(now, 20, 30, '-05:00').toISOString(), '2026-10-08T01:30:00.000Z')
  })
})
