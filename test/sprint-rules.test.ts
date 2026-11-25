import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Config } from '../src/config.ts'
import { assessItem } from '../src/sprint/assess.ts'
import { countedCheckpoints } from '../src/sprint/effort.ts'
import { buildRecord, dueCheckpoint, type CheckpointRecord } from '../src/sprint/record.ts'
import { lintSprint } from '../src/sprint/rules.ts'
import { config as base, historyOf, issue, snapshot } from './helpers.ts'

const config: Config = {
  ...base,
  sprint: {
    checkpoints: ['08:00', '13:00', '21:00'],
    utcOffset: '+09:00',
    pointsField: 'Story points',
    overrunField: 'Overrun',
    pointBudgets: { '1': 1, '2': 1, '3': 2, '5': 3, '8': 5 },
  },
}

const jst = (text: string) => new Date(`${text}+09:00`)
const NOW = jst('2026-10-30T14:00:00')
/** In Progress since 10/29 09:00. The checkpoints crossed are four: 10/29 13:00, 21:00, 10/30 08:00, and 13:00 */
const doingSince = [{ at: jst('2026-10-29T09:00:00').toISOString(), status: 'In Progress' }]

function doing(number: number, overrides: Parameters<typeof issue>[1] = {}) {
  return issue(number, { status: 'In Progress', assignee: 'SWE1', statusEvents: doingSince, ...overrides })
}

describe('countedCheckpoints', () => {
  const interval = (from: string, to: string) => ({ start: jst(from).getTime(), end: jst(to).getTime() })

  it('returns the checkpoints crossed, oldest first, regardless of the order of the periods; excludes checkpoints during which the team was stalled', () => {
    const later = interval('2026-10-30T07:00:00', '2026-10-30T14:00:00')
    const earlier = interval('2026-10-29T09:00:00', '2026-10-29T22:00:00')
    const all = countedCheckpoints([later, earlier], config.sprint!, () => false).map((one) => one.toISOString())
    assert.deepEqual(all, [jst('2026-10-29T13:00:00'), jst('2026-10-29T21:00:00'), jst('2026-10-30T08:00:00'), jst('2026-10-30T13:00:00')].map((one) => one.toISOString()))
    const blocked = countedCheckpoints([later, earlier], config.sprint!, (at) => at.getTime() === jst('2026-10-29T21:00:00').getTime()).map((one) => one.toISOString())
    assert.deepEqual(blocked, [jst('2026-10-29T13:00:00'), jst('2026-10-30T08:00:00'), jst('2026-10-30T13:00:00')].map((one) => one.toISOString()))
  })
})

describe('assessItem', () => {
  it('gives points, budget, effort, and overrun', () => {
    assert.deepEqual(assessItem(doing(1, { points: 3 }), historyOf(), config, NOW), {
      label: 'app#1',
      points: 3,
      budget: 2,
      effort: 4,
      over: 2,
      overSince: jst('2026-10-30T08:00:00').toISOString(),
    })
  })

  it('for an item that is blocked now, excludes the checkpoints from the day the block began', () => {
    const blocked = doing(1, { points: 3, reason: 'External wait', since: '2026-10-30' })
    assert.equal(assessItem(blocked, historyOf(), config, NOW).effort, 2)
  })

  it('for an item that was blocked in the checkpoint record, excludes those checkpoints', () => {
    const record: CheckpointRecord = {
      scheduledFor: jst('2026-10-29T21:00:00').toISOString(),
      recordedAt: jst('2026-10-29T21:01:00').toISOString(),
      items: [{ label: 'app#1', points: 3, budget: 2, effort: 2, over: 0, reason: 'Needs decision', assignee: 'SWE1' }],
    }
    assert.equal(assessItem(doing(1, { points: 3 }), historyOf([record]), config, NOW).effort, 3)
  })

  it('without a record of Status changes, effort and overrun are unknown (null)', () => {
    const unknown = issue(1, { status: 'In Progress', points: 3 })
    assert.deepEqual(assessItem(unknown, historyOf(), config, NOW), { label: 'app#1', points: 3, budget: 2, effort: null, over: null })
  })

  describe('checkpoint that reported the overrun (overSince)', () => {
    it('returns the first checkpoint counted beyond the budget (budget + 1st). The checkpoints crossed are four: 13:00, 21:00, 10/30 08:00, and 13:00', () => {
      assert.equal(assessItem(doing(1, { points: 3 }), historyOf(), config, NOW).overSince, jst('2026-10-30T08:00:00').toISOString())
      assert.equal(assessItem(doing(1, { points: 5 }), historyOf(), config, NOW).overSince, jst('2026-10-30T13:00:00').toISOString())
    })

    it('null when the budget has not been reached or is exactly met', () => {
      assert.equal(assessItem(doing(1, { points: 8 }), historyOf(), config, NOW).overSince, null)
      // Three checkpoints are crossed by 10/30 09:00, which exactly reaches the budget (3) for 5 points
      assert.equal(assessItem(doing(1, { points: 5 }), historyOf(), config, jst('2026-10-30T09:00:00')).overSince, null)
    })

    it('since stalled checkpoints are excluded from the count, the result is a later checkpoint by that many', () => {
      const record: CheckpointRecord = {
        scheduledFor: jst('2026-10-29T13:00:00').toISOString(),
        recordedAt: jst('2026-10-29T13:01:00').toISOString(),
        items: [{ label: 'app#1', points: 3, budget: 2, effort: 1, over: 0, reason: 'Needs decision', assignee: 'SWE1' }],
      }
      assert.equal(assessItem(doing(1, { points: 3 }), historyOf([record]), config, NOW).overSince, jst('2026-10-30T13:00:00').toISOString())
    })

    it('null when there is no points or Status record (the overrun is unknown)', () => {
      assert.equal(assessItem(issue(1, { status: 'In Progress', points: 3 }), historyOf(), config, NOW).overSince, undefined)
      assert.equal(assessItem(doing(1), historyOf(), config, NOW).overSince, null)
    })
  })
})

describe('lintSprint', () => {
  const rules = (items: Parameters<typeof snapshot>[0], records: readonly CheckpointRecord[] = []) =>
    lintSprint(snapshot(items), historyOf(records), config, NOW).map((f) => `${f.rule} ${f.subject} ${f.severity}`)

  it('reports an In Progress issue that exceeded its budget, with the number exceeded', () => {
    const [finding] = lintSprint(snapshot([doing(1, { points: 3 })]), historyOf(), config, NOW)
    assert.equal(finding?.rule, 'S-POINTS-OVER')
    assert.match(finding?.message ?? '', /app#1 has taken 4 checkpoints against 3 points \(budget 2 checkpoints\) \(\+2\)/)
  })

  it('does not report an issue within budget', () => {
    assert.deepEqual(rules([doing(1, { points: 8 })]), [])
  })

  it('reports an In Progress or Next item that has no points', () => {
    assert.deepEqual(rules([doing(1), issue(2, { status: 'Next' }), issue(3)]), [
      'S-POINTS-MISSING app#1 medium',
      'S-POINTS-MISSING app#2 medium',
    ])
  })

  it('reports points that are not in the tier table', () => {
    assert.deepEqual(rules([doing(1, { points: 4 })]), ['S-POINTS-INVALID app#1 low'])
  })

  it('emits a checkpoint notice for 1 hour after a checkpoint is recorded', () => {
    const record: CheckpointRecord = {
      scheduledFor: jst('2026-10-30T13:00:00').toISOString(),
      recordedAt: jst('2026-10-30T13:01:00').toISOString(),
      items: [{ label: 'app#1', points: 3, budget: 2, effort: 4, over: 2, reason: 'None', assignee: 'SWE1' }],
    }
    const atCheckpoint = lintSprint(snapshot([]), historyOf([record]), config, jst('2026-10-30T13:30:00'))
    assert.deepEqual(atCheckpoint.map((f) => f.rule), ['S-CHECKPOINT'])
    assert.match(atCheckpoint[0]?.message ?? '', /Recorded checkpoint 13:00\. 1 In Progress, 1 over budget \(app#1 \+2\)\. Review, and decide the order until the next checkpoint \(21:00\)/)
    assert.deepEqual(lintSprint(snapshot([]), historyOf([record]), config, jst('2026-10-30T14:01:00')), [])
  })

  it('a checkpoint recorded late also emits a notice for 1 hour from the time it was recorded', () => {
    const late: CheckpointRecord = {
      scheduledFor: jst('2026-10-30T13:00:00').toISOString(),
      recordedAt: jst('2026-10-30T14:30:00').toISOString(),
      items: [],
    }
    assert.deepEqual(lintSprint(snapshot([]), historyOf([late]), config, jst('2026-10-30T15:00:00')).map((f) => f.rule), ['S-CHECKPOINT'])
    assert.match(lintSprint(snapshot([]), historyOf([late]), config, jst('2026-10-30T15:00:00'))[0]?.message ?? '', /Recorded checkpoint 13:00 \(recorded late, at 14:30\)/)
    assert.deepEqual(lintSprint(snapshot([]), historyOf([late]), config, jst('2026-10-30T15:31:00')), [])
  })

  it('emits nothing when there is no sprint config', () => {
    const { sprint: _s, ...plain } = config
    assert.deepEqual(lintSprint(snapshot([doing(1)]), historyOf(), plain, NOW), [])
  })
})

describe('checkpoint record', () => {
  it('keeps points, effort, overrun, and blocked reason for each In Progress issue', () => {
    const record = buildRecord(snapshot([doing(1, { points: 3 }), issue(2)]), historyOf(), config, jst('2026-10-30T13:00:00'), NOW)
    assert.equal(record.scheduledFor, jst('2026-10-30T13:00:00').toISOString())
    assert.equal(record.snapshotAt, snapshot([]).fetchedAt)
    assert.deepEqual(record.items, [
      { label: 'app#1', points: 3, budget: 2, effort: 4, over: 2, overSince: jst('2026-10-30T08:00:00').toISOString(), reason: 'None', assignee: 'SWE1' },
    ])
  })

  it('returns the last checkpoint not yet recorded; null when already recorded', () => {
    const due = dueCheckpoint([], config, NOW)
    assert.equal(due?.toISOString(), jst('2026-10-30T13:00:00').toISOString())
    const done: CheckpointRecord = { scheduledFor: due?.toISOString() ?? '', recordedAt: NOW.toISOString(), items: [] }
    assert.equal(dueCheckpoint([done], config, NOW), null)
  })
})

describe('integration', async () => {
  const { lintAll } = await import('../src/findings/lint.ts')
  const { formatStatusline } = await import('../src/findings/format.ts')
  const { formatPoints } = await import('../src/sprint/report.ts')

  it('lintAll also emits sprint findings using the checkpoint record', () => {
    const ctx = { snapshot: { ...snapshot([doing(1, { points: 3 })]), fetchedAt: NOW.toISOString() }, members: [], acks: [], config, now: NOW, checkpoints: [] }
    assert.deepEqual(lintAll(ctx).active.map((f) => f.rule), ['S-POINTS-OVER'])
  })

  it('the statusline shows the overrun count', () => {
    const [over] = lintSprint(snapshot([doing(1, { points: 3 })]), historyOf(), config, NOW)
    assert.equal(formatStatusline(over === undefined ? [] : [over]), '⚠ board high 0 medium 0 │ overrun 1')
  })

  it('scrum points shows In Progress issues in a table, most exceeded first', () => {
    const text = formatPoints(snapshot([doing(1, { points: 8 }), doing(2, { points: 3 }), doing(3)]), historyOf(), config, NOW)
    const lines = text.split('\n')
    assert.equal(lines[0], 'issue\tpoints\tbudget\teffort\toverrun\tblocked reason\tassignee')
    assert.equal(lines[1], 'app#2\t3\t2\t4\t+2\tNone\tSWE1')
    assert.equal(lines[2], 'app#1\t8\t5\t4\t0\tNone\tSWE1')
    assert.equal(lines[3], 'app#3\t-\t-\t4\t-\tNone\tSWE1')
    assert.match(lines.at(-1) ?? '', /Next checkpoint: 21:00/)
  })

  it('the effort in scrum points excludes the checkpoints that were stalled in the checkpoint record', () => {
    const record: CheckpointRecord = {
      scheduledFor: jst('2026-10-29T21:00:00').toISOString(),
      recordedAt: jst('2026-10-29T21:01:00').toISOString(),
      items: [{ label: 'app#2', points: 3, budget: 2, effort: 2, over: 0, reason: 'Needs decision', assignee: 'SWE1' }],
    }
    const text = formatPoints(snapshot([doing(2, { points: 3 })]), historyOf([record]), config, NOW)
    assert.equal(text.split('\n')[1], 'app#2\t3\t2\t3\t+1\tNone\tSWE1')
  })
})
