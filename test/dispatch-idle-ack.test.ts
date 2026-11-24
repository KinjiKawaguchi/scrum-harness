import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkIdleAck, slotInstant } from '../src/dispatch/idle-ack.ts'
import { config, NOW } from './helpers.ts'

// NOW は 2026-10-08 15:00 JST
const check = (reason: string, durationMs = 3_600_000, now = NOW) => checkIdleAck({ reason, durationMs, now, config })

describe('checkIdleAck', () => {
  it('「<オーナー>の答え待ち」は 1 時間まで受け入れ、枠は付けない', () => {
    assert.deepEqual(check('オーナーの答え待ち'), { ok: true, slotAt: null })
  })

  it('理由の後ろに文字を足した形は、受け入れない (部分一致にしない)', () => {
    assert.equal(check('オーナーの答え待ち、余力が少ない').ok, false)
    assert.equal(check('枠 15:30 まで').ok, false)
    assert.equal(check('枠 15:30、余力').ok, false)
    assert.equal(check('前置き 枠 15:30').ok, false)
  })

  it('1 時間より長い期限は、理由が正しくても受け入れない', () => {
    const result = check('オーナーの答え待ち', 3_600_001)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /最長 1 時間/)
  })

  it('「枠 HH:MM」は、枠の始まりを残して受け入れる', () => {
    assert.deepEqual(check('枠 15:30'), { ok: true, slotAt: '2026-10-08T06:30:00.000Z' })
    assert.deepEqual(check('枠 16:15'), { ok: true, slotAt: '2026-10-08T07:15:00.000Z' })
  })

  it('枠の始まりが 1 時間 15 分より先なら、受け入れない (枠の 15 分前までに期限が切れるため)', () => {
    const result = check('枠 16:16')
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /1 時間 15 分以内/)
  })

  it('枠の中 (始まりから 1 時間以内) なら、始まりの時刻のまま受け入れる', () => {
    assert.deepEqual(check('枠 14:30'), { ok: true, slotAt: '2026-10-08T05:30:00.000Z' })
  })

  it('1 時間より前に終わった枠の時刻は、明日の枠とみなして、受け入れない', () => {
    assert.equal(check('枠 08:00').ok, false)
  })

  it('コンテキストの余力は理由にできない。決まった言葉以外も受け入れない', () => {
    const context = check('コンテキストの余力がない')
    assert.equal(context.ok, false)
    assert.match(context.ok ? '' : context.message, /コンテキストの余力は理由にできない/)
    for (const reason of ['枠', '枠 25:00', '枠 9:30', '今夜の作業待ち', '']) assert.equal(check(reason).ok, false, reason)
  })
})

describe('slotInstant', () => {
  it('時差の側の日付で、その時刻の瞬間を返す (日付をまたぐ UTC の側でも)', () => {
    const late = new Date('2026-10-08T15:30:00.000Z') // 10-09 00:30 JST
    assert.equal(slotInstant(late, 0, 45, '+09:00').toISOString(), '2026-10-08T15:45:00.000Z')
  })

  it('負の時差も扱う', () => {
    const now = new Date('2026-10-08T01:00:00.000Z') // 10-07 20:00 -05:00
    assert.equal(slotInstant(now, 20, 30, '-05:00').toISOString(), '2026-10-08T01:30:00.000Z')
  })
})
