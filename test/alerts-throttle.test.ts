import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyThrottle, newlyPushed, recordPushed } from '../src/alerts/throttle.ts'
import type { Notice } from '../src/alerts/types.ts'
import { NOW } from './helpers.ts'
import { enabled, minutesAgo, stateWith } from './alerts-fixtures.ts'

const owner = (key = 'E-STALL:app#100:t1'): Notice => ({
  key,
  kind: 'owner',
  text: '- E-STALL app#100: send the owner one PushNotification',
  desktop: { title: 'scrum-harness', body: 'b' },
  throttle: { key: 'epic:app#100', head: 'E-STALL app#100', detail: 'Nobody has been moving Epic app#100 for 70 minutes.', minutes: 24 * 60 },
})
const plain: Notice = { key: 'E-STALL:x', kind: 'owner', text: '- x', desktop: { title: 't', body: 'b' } }
const withPush = (minutes: number) => stateWith({ ownerPushedAt: { 'epic:app#100': minutesAgo(minutes) } })

describe('applyThrottle', () => {
  it('a notification with a new fingerprint within 24 hours of the previous one is replaced by a one-line info for the liaison to read, and its desktop notification is dropped', () => {
    const [held] = applyThrottle([owner()], withPush(60), enabled, NOW)
    assert.equal(held?.kind, 'info')
    assert.equal(held?.key, 'E-STALL:app#100:t1:held')
    assert.equal(held?.desktop, undefined)
    assert.equal(
      held?.text,
      '- E-STALL app#100: the owner was already notified at 14:00, and the same subject is sent at most once per 24 h, so it is not sent this time (Nobody has been moving Epic app#100 for 70 minutes.)',
    )
  })

  it('exactly 24 hours later it passes as is (it reaches the owner); at 23 hours 59 minutes it becomes one line', () => {
    assert.equal(applyThrottle([owner()], withPush(24 * 60), enabled, NOW)[0]?.kind, 'owner')
    assert.equal(applyThrottle([owner()], withPush(24 * 60 - 1), enabled, NOW)[0]?.kind, 'info')
  })

  it('a notification whose fingerprint was already emitted passes as is; a desktop notification alone, or a liaison alone, counts as an emitted fingerprint', () => {
    const sentDesktop = stateWith({ ...withPush(5), desktopSent: ['E-STALL:app#100:t1'] })
    const sentLiaison = stateWith({ ...withPush(5), liaisonSent: ['E-STALL:app#100:t1'] })
    assert.equal(applyThrottle([owner()], sentDesktop, enabled, NOW)[0]?.kind, 'owner')
    assert.equal(applyThrottle([owner()], sentLiaison, enabled, NOW)[0]?.kind, 'owner')
  })

  it('a notification with no record of being sent, or without the marker that spaces them out (such as Q-EMPTY-OWNER), passes as is', () => {
    assert.equal(applyThrottle([owner()], stateWith({}), enabled, NOW)[0]?.kind, 'owner')
    assert.equal(applyThrottle([plain], withPush(5), enabled, NOW)[0]?.kind, 'owner')
  })

  it('the notification record of another Epic does not affect this Epic', () => {
    const other = stateWith({ ownerPushedAt: { 'epic:app#200': minutesAgo(5) } })
    assert.equal(applyThrottle([owner()], other, enabled, NOW)[0]?.kind, 'owner')
  })

  it('the interval follows minutes of the notification marker and also appears in the one-line text (in minutes when not divisible by 60)', () => {
    const every = (minutes: number): Notice => ({ ...owner(), throttle: { ...(owner().throttle as NonNullable<Notice['throttle']>), minutes } })
    assert.match(applyThrottle([every(120)], withPush(10), enabled, NOW)[0]?.text ?? '', /once per 2 h/)
    assert.match(applyThrottle([every(90)], withPush(10), enabled, NOW)[0]?.text ?? '', /once per 90 min/)
    assert.equal(applyThrottle([every(90)], withPush(90), enabled, NOW)[0]?.kind, 'owner')
  })
})

describe('newlyPushed and recordPushed', () => {
  it('returns only notifications that carry a spacing marker and are being emitted for the first time now', () => {
    const sent = stateWith({ desktopSent: ['E-STALL:app#100:t0'] })
    assert.deepEqual(newlyPushed([owner('E-STALL:app#100:t0'), owner('E-STALL:app#100:t1'), plain], sent).map((notice) => notice.key), ['E-STALL:app#100:t1'])
    assert.deepEqual(newlyPushed([{ ...owner(), kind: 'info' }], stateWith({})), [])
  })

  it('writes the notification time per Epic with the current time; drops records older than the interval', () => {
    const before = stateWith({ ownerPushedAt: { 'epic:app#200': minutesAgo(24 * 60), 'epic:app#300': minutesAgo(24 * 60 - 1) } })
    assert.deepEqual(recordPushed(before, [owner()], enabled, NOW), { 'epic:app#100': NOW.toISOString(), 'epic:app#300': minutesAgo(24 * 60 - 1) })
    assert.deepEqual(recordPushed(before, [], enabled, NOW), { 'epic:app#300': minutesAgo(24 * 60 - 1) })
  })
})
