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
  it('直前の通知から 24 時間のうちの、新しい指紋の通知は、窓口に読ませる 1 行 (info) に替え、macOS の通知を外す', () => {
    const [held] = applyThrottle([owner()], withPush(60), enabled, NOW)
    assert.equal(held?.kind, 'info')
    assert.equal(held?.key, 'E-STALL:app#100:t1:held')
    assert.equal(held?.desktop, undefined)
    assert.equal(
      held?.text,
      '- E-STALL app#100: the owner was already notified at 14:00, and the same subject is sent at most once per 24 h, so it is not sent this time (Nobody has been moving Epic app#100 for 70 minutes.)',
    )
  })

  it('24 時間ちょうどたてば、そのまま (オーナーに出る)。23 時間 59 分なら 1 行にする', () => {
    assert.equal(applyThrottle([owner()], withPush(24 * 60), enabled, NOW)[0]?.kind, 'owner')
    assert.equal(applyThrottle([owner()], withPush(24 * 60 - 1), enabled, NOW)[0]?.kind, 'info')
  })

  it('すでに出した指紋の通知は、そのまま。macOS の通知だけでも、窓口にだけでも、出した指紋として数える', () => {
    const sentDesktop = stateWith({ ...withPush(5), desktopSent: ['E-STALL:app#100:t1'] })
    const sentLiaison = stateWith({ ...withPush(5), liaisonSent: ['E-STALL:app#100:t1'] })
    assert.equal(applyThrottle([owner()], sentDesktop, enabled, NOW)[0]?.kind, 'owner')
    assert.equal(applyThrottle([owner()], sentLiaison, enabled, NOW)[0]?.kind, 'owner')
  })

  it('通知した記録が無いか、間隔を空ける印が無い通知 (Q-EMPTY-OWNER など) は、そのまま', () => {
    assert.equal(applyThrottle([owner()], stateWith({}), enabled, NOW)[0]?.kind, 'owner')
    assert.equal(applyThrottle([plain], withPush(5), enabled, NOW)[0]?.kind, 'owner')
  })

  it('別の Epic の通知の記録は、この Epic に効かない', () => {
    const other = stateWith({ ownerPushedAt: { 'epic:app#200': minutesAgo(5) } })
    assert.equal(applyThrottle([owner()], other, enabled, NOW)[0]?.kind, 'owner')
  })

  it('間隔は通知の印の minutes に従い、1 行の文にも出る (60 で割り切れなければ分)', () => {
    const every = (minutes: number): Notice => ({ ...owner(), throttle: { ...(owner().throttle as NonNullable<Notice['throttle']>), minutes } })
    assert.match(applyThrottle([every(120)], withPush(10), enabled, NOW)[0]?.text ?? '', /once per 2 h/)
    assert.match(applyThrottle([every(90)], withPush(10), enabled, NOW)[0]?.text ?? '', /once per 90 min/)
    assert.equal(applyThrottle([every(90)], withPush(90), enabled, NOW)[0]?.kind, 'owner')
  })
})

describe('newlyPushed と recordPushed', () => {
  it('いま初めて出す、間隔を空ける印のある通知だけを返す', () => {
    const sent = stateWith({ desktopSent: ['E-STALL:app#100:t0'] })
    assert.deepEqual(newlyPushed([owner('E-STALL:app#100:t0'), owner('E-STALL:app#100:t1'), plain], sent).map((notice) => notice.key), ['E-STALL:app#100:t1'])
    assert.deepEqual(newlyPushed([{ ...owner(), kind: 'info' }], stateWith({})), [])
  })

  it('通知した時刻を、Epic ごとに、いまの時刻で書く。間隔より前の記録は捨てる', () => {
    const before = stateWith({ ownerPushedAt: { 'epic:app#200': minutesAgo(24 * 60), 'epic:app#300': minutesAgo(24 * 60 - 1) } })
    assert.deepEqual(recordPushed(before, [owner()], enabled, NOW), { 'epic:app#100': NOW.toISOString(), 'epic:app#300': minutesAgo(24 * 60 - 1) })
    assert.deepEqual(recordPushed(before, [], enabled, NOW), { 'epic:app#300': minutesAgo(24 * 60 - 1) })
  })
})
