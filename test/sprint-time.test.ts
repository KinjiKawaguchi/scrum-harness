import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkpointsBetween, latestCheckpoint, nextCheckpoint } from '../src/sprint/checkpoints.ts'
import { budgetFor, countEffort, doingIntervals } from '../src/sprint/effort.ts'
import type { SprintConfig } from '../src/config.ts'

const sprint: SprintConfig = {
  checkpoints: ['08:00', '13:00', '21:00'],
  utcOffset: '+09:00',
  pointsField: 'Story points',
  overrunField: 'Overrun',
  pointBudgets: { '1': 1, '2': 1, '3': 2, '5': 3, '8': 5 },
}

const jst = (text: string) => new Date(`${text}+09:00`)
const iso = (dates: readonly Date[]) => dates.map((date) => date.toISOString())

describe('checkpoint times', () => {
  it('lists the checkpoints in the period (from, to], across days', () => {
    const found = checkpointsBetween(jst('2026-10-29T12:00:00'), jst('2026-10-30T08:00:00'), sprint)
    assert.deepEqual(iso(found), iso([jst('2026-10-29T13:00:00'), jst('2026-10-29T21:00:00'), jst('2026-10-30T08:00:00')]))
  })

  it('does not include a checkpoint exactly at the start', () => {
    assert.deepEqual(checkpointsBetween(jst('2026-10-30T08:00:00'), jst('2026-10-30T12:59:00'), sprint), [])
  })

  it('the last checkpoint up to now, and the next checkpoint', () => {
    assert.equal(latestCheckpoint(jst('2026-10-30T07:59:00'), sprint).toISOString(), jst('2026-10-29T21:00:00').toISOString())
    assert.equal(latestCheckpoint(jst('2026-10-30T13:00:00'), sprint).toISOString(), jst('2026-10-30T13:00:00').toISOString())
    assert.equal(nextCheckpoint(jst('2026-10-30T13:00:00'), sprint).toISOString(), jst('2026-10-30T21:00:00').toISOString())
  })
})

describe('In Progress periods', () => {
  const events = [
    { at: '2026-10-22T22:39:31Z', status: 'Next' },
    { at: '2026-10-22T23:02:25Z', status: 'In Progress' },
    { at: '2026-10-24T01:58:51Z', status: 'Backlog' },
    { at: '2026-10-29T00:36:02Z', status: 'In Progress' },
  ]

  it('lists the span from entering In Progress to leaving it, once per entry and exit, and closes it at now if still In Progress', () => {
    const now = new Date('2026-10-30T01:00:00Z')
    assert.deepEqual(doingIntervals(events, 'In Progress', now), [
      { start: Date.parse('2026-10-22T23:02:25Z'), end: Date.parse('2026-10-24T01:58:51Z') },
      { start: Date.parse('2026-10-29T00:36:02Z'), end: now.getTime() },
    ])
  })

  it('counts after re-sorting by time', () => {
    const now = new Date('2026-10-30T01:00:00Z')
    assert.deepEqual(doingIntervals(events.toReversed(), 'In Progress', now), doingIntervals(events, 'In Progress', now))
  })
})

describe('effort and budget', () => {
  const intervals = [{ start: jst('2026-10-29T09:00:00').getTime(), end: jst('2026-10-30T14:00:00').getTime() }]

  it('counts the checkpoints crossed during the In Progress period', () => {
    // 10/29 13:00, 21:00, 10/30 08:00, 13:00
    assert.equal(countEffort(intervals, sprint, () => false), 4)
  })

  it('does not count checkpoints during which the team was stalled', () => {
    const blocked = (at: Date) => at.getTime() >= jst('2026-10-30T00:00:00').getTime()
    assert.equal(countEffort(intervals, sprint, blocked), 2)
  })

  it('subtracts the number of budget checkpoints from the points; points not in the tier table give null', () => {
    assert.equal(budgetFor(3, sprint), 2)
    assert.equal(budgetFor(8, sprint), 5)
    assert.equal(budgetFor(4, sprint), null)
    assert.equal(budgetFor(null, sprint), null)
  })
})
