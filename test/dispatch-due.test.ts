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
  reason: 'オーナーの答え待ち',
  at: minutesAgo(10),
  ...overrides,
})
const record = (minutes: number, member = 'SWE1'): DispatchRecord => ({ at: minutesAgo(minutes), member, label: 'app#11', title: 'issue 11' })

describe('dispatchDue', () => {
  it('空きが idleMinutes 続き、受け入れも渡した記録も無ければ、渡す', () => {
    assert.deepEqual(dispatchDue(idle(10), [], [], enabled, NOW), { isDue: true })
  })

  it('dispatch の設定が無いか、有効でなければ渡さない', () => {
    assert.deepEqual(dispatchDue(idle(30), [], [], config, NOW), { isDue: false, reason: 'disabled' })
    const off = { ...config, dispatch: { ...enabled.dispatch, enabled: false } }
    assert.deepEqual(dispatchDue(idle(30), [], [], off, NOW), { isDue: false, reason: 'disabled' })
  })

  it('渡す相手に入っていない人には渡さない', () => {
    const only = { ...enabled, dispatch: { ...enabled.dispatch, members: ['SWE2'] } }
    assert.deepEqual(dispatchDue(idle(30), [], [], only, NOW), { isDue: false, reason: 'not-target' })
    assert.deepEqual(dispatchDue(idle(30, 'SWE2'), [], [], only, NOW), { isDue: true })
  })

  it('空いていない人と、空きが短い人には渡さない', () => {
    assert.deepEqual(dispatchDue({ name: 'SWE1', state: 'busy', since: minutesAgo(30) }, [], [], enabled, NOW), { isDue: false, reason: 'not-idle' })
    assert.deepEqual(dispatchDue({ name: 'SWE1', state: 'unknown', since: null }, [], [], enabled, NOW), { isDue: false, reason: 'not-idle' })
    assert.deepEqual(dispatchDue(idle(9), [], [], enabled, NOW), { isDue: false, reason: 'too-short' })
  })

  it('渡した後、その人が動かないまま (空きが渡す前から続いている) なら、重ねて渡さない', () => {
    assert.deepEqual(dispatchDue(idle(30), [], [record(20)], enabled, NOW), { isDue: false, reason: 'already-dispatched' })
    assert.deepEqual(dispatchDue(idle(30), [], [record(40)], enabled, NOW), { isDue: true })
    assert.deepEqual(dispatchDue(idle(30), [], [record(20, 'SWE2')], enabled, NOW), { isDue: true })
  })

  it('有効な T-IDLE の受け入れがあれば渡さない。期限切れ、別の人、別の規則の受け入れは数えない', () => {
    assert.deepEqual(dispatchDue(idle(30), [ack()], [], enabled, NOW), { isDue: false, reason: 'accepted' })
    assert.deepEqual(dispatchDue(idle(30), [ack({ until: minutesAgo(1) })], [], enabled, NOW), { isDue: true })
    assert.deepEqual(dispatchDue(idle(30), [ack({ subject: 'SWE2' })], [], enabled, NOW), { isDue: true })
    assert.deepEqual(dispatchDue(idle(30), [ack({ rule: 'T-WAITING' })], [], enabled, NOW), { isDue: true })
  })

  it('枠の受け入れは、枠の始まりの 15 分前までは渡すのを止めず、その後は止める', () => {
    const slot = (minutes: number) => ack({ reason: '枠 16:00', slotAt: minutesLater(minutes) })
    assert.deepEqual(dispatchDue(idle(30), [slot(16)], [], enabled, NOW), { isDue: true })
    assert.deepEqual(dispatchDue(idle(30), [slot(15)], [], enabled, NOW), { isDue: false, reason: 'accepted' })
    assert.deepEqual(dispatchDue(idle(30), [slot(-10)], [], enabled, NOW), { isDue: false, reason: 'accepted' })
  })
})

describe('idleGate と促しの記録', () => {
  it('促しの記録は、新しい issue を渡すかの判定 (重ねて渡さない) に数えない', async () => {
    const { idleGate } = await import('../src/dispatch/due.ts')
    const nudged: DispatchRecord = { kind: 'nudge', at: minutesAgo(5), member: 'SWE1', label: 'app#1', title: 't' }
    assert.deepEqual(dispatchDue(idle(30), [], [nudged], enabled, NOW), { isDue: true })
    assert.deepEqual(idleGate(idle(30), [], enabled, NOW), { isDue: true })
    assert.deepEqual(idleGate(idle(30), [ack()], enabled, NOW), { isDue: false, reason: 'accepted' })
  })
})

describe('保存された T-IDLE の受け入れの検査', () => {
  const old = (overrides: Partial<Ack> = {}) => ack({ at: minutesAgo(10), until: minutesLater(230), reason: '余力が少ない', ...overrides })

  it('検査を入れる前に作られた受け入れ (長い期限、余力などの理由) は、渡すのを止めない', () => {
    assert.deepEqual(dispatchDue(idle(30), [old()], [], enabled, NOW), { isDue: true })
    assert.deepEqual(dispatchDue(idle(30), [old({ reason: 'オーナーの答え待ち', until: minutesLater(230) })], [], enabled, NOW), { isDue: true })
  })

  it('理由の後ろに文字があるものは、止めない。理由が完全一致で、期限が 1 時間以内のものは、止める', () => {
    assert.deepEqual(dispatchDue(idle(30), [ack({ reason: 'オーナーの答え待ち、余力が少ない' })], [], enabled, NOW), { isDue: true })
    assert.deepEqual(dispatchDue(idle(30), [ack({ reason: 'オーナーの答え待ち' })], [], enabled, NOW), { isDue: false, reason: 'accepted' })
  })

  it('枠の理由でも、枠の始まり (slotAt) の無い古い形は、止めない', () => {
    assert.deepEqual(dispatchDue(idle(30), [ack({ reason: '枠 16:00' })], [], enabled, NOW), { isDue: true })
  })
})

describe('isValidIdleAck', () => {
  const made = (overrides: Partial<Ack>): Ack => ack({ at: minutesAgo(0), until: minutesLater(60), ...overrides })

  it('「<オーナー>の答え待ち」の完全一致で、期限が 1 時間以内なら通る (ちょうど 1 時間も通る)', () => {
    assert.equal(isValidIdleAck(made({ reason: 'オーナーの答え待ち' }), enabled), true)
    assert.equal(isValidIdleAck(made({ reason: 'オーナーの答え待ち', until: minutesLater(61) }), enabled), false)
  })

  it('理由の前後に文字があるものは通らない', () => {
    assert.equal(isValidIdleAck(made({ reason: 'オーナーの答え待ち、余力が少ない' }), enabled), false)
    assert.equal(isValidIdleAck(made({ reason: '長い オーナーの答え待ち' }), enabled), false)
  })

  it('「枠 HH:MM」は、枠の始まりが書いてあり、形が完全一致のとき通る', () => {
    assert.equal(isValidIdleAck(made({ reason: '枠 16:00', slotAt: minutesLater(30) }), enabled), true)
    assert.equal(isValidIdleAck(made({ reason: '枠 16:00', slotAt: undefined }), enabled), false)
    assert.equal(isValidIdleAck(made({ reason: '枠 16:00 まで', slotAt: minutesLater(30) }), enabled), false)
  })

  it('期限か作った時刻が読めないものは通らない。T-IDLE 以外の受け入れは見ない', () => {
    assert.equal(isValidIdleAck(made({ reason: 'オーナーの答え待ち', at: 'x' }), enabled), false)
    assert.equal(isValidIdleAck(made({ rule: 'B-WIP-OVER', reason: '何でも', until: minutesLater(5000) }), enabled), true)
  })
})
