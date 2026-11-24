import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkpointsBetween, latestCheckpoint, nextCheckpoint } from '../src/sprint/checkpoints.ts'
import { budgetFor, countEffort, doingIntervals } from '../src/sprint/effort.ts'
import type { SprintConfig } from '../src/config.ts'

const sprint: SprintConfig = {
  checkpoints: ['08:00', '13:00', '21:00'],
  utcOffset: '+09:00',
  pointsField: 'ストーリーポイント',
  overrunField: '超過',
  pointBudgets: { '1': 1, '2': 1, '3': 2, '5': 3, '8': 5 },
}

const jst = (text: string) => new Date(`${text}+09:00`)
const iso = (dates: readonly Date[]) => dates.map((date) => date.toISOString())

describe('節目の時刻', () => {
  it('期間 (from, to] にある節目を、日をまたいで並べる', () => {
    const found = checkpointsBetween(jst('2026-10-29T12:00:00'), jst('2026-10-30T08:00:00'), sprint)
    assert.deepEqual(iso(found), iso([jst('2026-10-29T13:00:00'), jst('2026-10-29T21:00:00'), jst('2026-10-30T08:00:00')]))
  })

  it('始まりちょうどの節目は含めない', () => {
    assert.deepEqual(checkpointsBetween(jst('2026-10-30T08:00:00'), jst('2026-10-30T12:59:00'), sprint), [])
  })

  it('今以前の最後の節目と、次の節目', () => {
    assert.equal(latestCheckpoint(jst('2026-10-30T07:59:00'), sprint).toISOString(), jst('2026-10-29T21:00:00').toISOString())
    assert.equal(latestCheckpoint(jst('2026-10-30T13:00:00'), sprint).toISOString(), jst('2026-10-30T13:00:00').toISOString())
    assert.equal(nextCheckpoint(jst('2026-10-30T13:00:00'), sprint).toISOString(), jst('2026-10-30T21:00:00').toISOString())
  })
})

describe('作業中の期間', () => {
  const events = [
    { at: '2026-10-22T22:39:31Z', status: '次にやる' },
    { at: '2026-10-22T23:02:25Z', status: '作業中' },
    { at: '2026-10-24T01:58:51Z', status: 'バックログ' },
    { at: '2026-10-29T00:36:02Z', status: '作業中' },
  ]

  it('作業中に入ってから出るまでを、出入りの回数だけ並べ、今も作業中なら今で閉じる', () => {
    const now = new Date('2026-10-30T01:00:00Z')
    assert.deepEqual(doingIntervals(events, '作業中', now), [
      { start: Date.parse('2026-10-22T23:02:25Z'), end: Date.parse('2026-10-24T01:58:51Z') },
      { start: Date.parse('2026-10-29T00:36:02Z'), end: now.getTime() },
    ])
  })

  it('時刻の順に並べ直してから数える', () => {
    const now = new Date('2026-10-30T01:00:00Z')
    assert.deepEqual(doingIntervals(events.toReversed(), '作業中', now), doingIntervals(events, '作業中', now))
  })
})

describe('手間と目安', () => {
  const intervals = [{ start: jst('2026-10-29T09:00:00').getTime(), end: jst('2026-10-30T14:00:00').getTime() }]

  it('作業中の期間にまたいだ節目を数える', () => {
    // 10/29 13:00、21:00、10/30 08:00、13:00
    assert.equal(countEffort(intervals, sprint, () => false), 4)
  })

  it('止まっていた節目は数えない', () => {
    const blocked = (at: Date) => at.getTime() >= jst('2026-10-30T00:00:00').getTime()
    assert.equal(countEffort(intervals, sprint, blocked), 2)
  })

  it('ポイントから目安の節目の数を引く。段に無いポイントは null', () => {
    assert.equal(budgetFor(3, sprint), 2)
    assert.equal(budgetFor(8, sprint), 5)
    assert.equal(budgetFor(4, sprint), null)
    assert.equal(budgetFor(null, sprint), null)
  })
})
