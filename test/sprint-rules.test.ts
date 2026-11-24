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
/** 10/29 09:00 から作業中。またいだ節目は 10/29 13:00、21:00、10/30 08:00、13:00 の4つ */
const doingSince = [{ at: jst('2026-10-29T09:00:00').toISOString(), status: 'In Progress' }]

function doing(number: number, overrides: Parameters<typeof issue>[1] = {}) {
  return issue(number, { status: 'In Progress', assignee: 'SWE1', statusEvents: doingSince, ...overrides })
}

describe('countedCheckpoints', () => {
  const interval = (from: string, to: string) => ({ start: jst(from).getTime(), end: jst(to).getTime() })

  it('またいだ節目を、期間の並びに関わらず、古い順に返す。止まっていた節目は除く', () => {
    const later = interval('2026-10-30T07:00:00', '2026-10-30T14:00:00')
    const earlier = interval('2026-10-29T09:00:00', '2026-10-29T22:00:00')
    const all = countedCheckpoints([later, earlier], config.sprint!, () => false).map((one) => one.toISOString())
    assert.deepEqual(all, [jst('2026-10-29T13:00:00'), jst('2026-10-29T21:00:00'), jst('2026-10-30T08:00:00'), jst('2026-10-30T13:00:00')].map((one) => one.toISOString()))
    const blocked = countedCheckpoints([later, earlier], config.sprint!, (at) => at.getTime() === jst('2026-10-29T21:00:00').getTime()).map((one) => one.toISOString())
    assert.deepEqual(blocked, [jst('2026-10-29T13:00:00'), jst('2026-10-30T08:00:00'), jst('2026-10-30T13:00:00')].map((one) => one.toISOString()))
  })
})

describe('assessItem', () => {
  it('ポイント・目安・手間・超過を出す', () => {
    assert.deepEqual(assessItem(doing(1, { points: 3 }), historyOf(), config, NOW), {
      label: 'app#1',
      points: 3,
      budget: 2,
      effort: 4,
      over: 2,
      overSince: jst('2026-10-30T08:00:00').toISOString(),
    })
  })

  it('今止まっているものは、止まり始めた日からの節目を除く', () => {
    const blocked = doing(1, { points: 3, reason: 'External wait', since: '2026-10-30' })
    assert.equal(assessItem(blocked, historyOf(), config, NOW).effort, 2)
  })

  it('節目の記録で止まっていたものは、その節目を除く', () => {
    const record: CheckpointRecord = {
      scheduledFor: jst('2026-10-29T21:00:00').toISOString(),
      recordedAt: jst('2026-10-29T21:01:00').toISOString(),
      items: [{ label: 'app#1', points: 3, budget: 2, effort: 2, over: 0, reason: 'Needs decision', assignee: 'SWE1' }],
    }
    assert.equal(assessItem(doing(1, { points: 3 }), historyOf([record]), config, NOW).effort, 3)
  })

  it('Status の変化の記録が無ければ、手間と超過は分からない (null)', () => {
    const unknown = issue(1, { status: 'In Progress', points: 3 })
    assert.deepEqual(assessItem(unknown, historyOf(), config, NOW), { label: 'app#1', points: 3, budget: 2, effort: null, over: null })
  })

  describe('超過を出した節目 (overSince)', () => {
    it('目安を超えて数えた最初の節目 (目安 + 1 番目) を返す。またいだ節目は 13:00、21:00、10/30 08:00、13:00 の 4 つ', () => {
      assert.equal(assessItem(doing(1, { points: 3 }), historyOf(), config, NOW).overSince, jst('2026-10-30T08:00:00').toISOString())
      assert.equal(assessItem(doing(1, { points: 5 }), historyOf(), config, NOW).overSince, jst('2026-10-30T13:00:00').toISOString())
    })

    it('目安に届いていない、ちょうど目安のときは、null', () => {
      assert.equal(assessItem(doing(1, { points: 8 }), historyOf(), config, NOW).overSince, null)
      // 10/30 09:00 までにまたいだ節目は 3 つで、ポイント 5 の目安 (3) にちょうど届く
      assert.equal(assessItem(doing(1, { points: 5 }), historyOf(), config, jst('2026-10-30T09:00:00')).overSince, null)
    })

    it('止まっていた節目を除いて数えるので、その分だけ後ろの節目になる', () => {
      const record: CheckpointRecord = {
        scheduledFor: jst('2026-10-29T13:00:00').toISOString(),
        recordedAt: jst('2026-10-29T13:01:00').toISOString(),
        items: [{ label: 'app#1', points: 3, budget: 2, effort: 1, over: 0, reason: 'Needs decision', assignee: 'SWE1' }],
      }
      assert.equal(assessItem(doing(1, { points: 3 }), historyOf([record]), config, NOW).overSince, jst('2026-10-30T13:00:00').toISOString())
    })

    it('ポイントや Status の記録が無いときは、null (超過は分からない)', () => {
      assert.equal(assessItem(issue(1, { status: 'In Progress', points: 3 }), historyOf(), config, NOW).overSince, undefined)
      assert.equal(assessItem(doing(1), historyOf(), config, NOW).overSince, null)
    })
  })
})

describe('lintSprint', () => {
  const rules = (items: Parameters<typeof snapshot>[0], records: readonly CheckpointRecord[] = []) =>
    lintSprint(snapshot(items), historyOf(records), config, NOW).map((f) => `${f.rule} ${f.subject} ${f.severity}`)

  it('目安を超えた作業中の issue を、超えた数つきで出す', () => {
    const [finding] = lintSprint(snapshot([doing(1, { points: 3 })]), historyOf(), config, NOW)
    assert.equal(finding?.rule, 'S-POINTS-OVER')
    assert.match(finding?.message ?? '', /app#1 has taken 4 checkpoints against 3 points \(budget 2 checkpoints\) \(\+2\)/)
  })

  it('目安の内なら出さない', () => {
    assert.deepEqual(rules([doing(1, { points: 8 })]), [])
  })

  it('作業中か次にやるで、ポイントが無いものを出す', () => {
    assert.deepEqual(rules([doing(1), issue(2, { status: 'Next' }), issue(3)]), [
      'S-POINTS-MISSING app#1 medium',
      'S-POINTS-MISSING app#2 medium',
    ])
  })

  it('段に無いポイントを出す', () => {
    assert.deepEqual(rules([doing(1, { points: 4 })]), ['S-POINTS-INVALID app#1 low'])
  })

  it('節目を記録してから1時間は、節目の知らせを出す', () => {
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

  it('遅れて記録した節目も、記録した時刻から1時間は知らせを出す', () => {
    const late: CheckpointRecord = {
      scheduledFor: jst('2026-10-30T13:00:00').toISOString(),
      recordedAt: jst('2026-10-30T14:30:00').toISOString(),
      items: [],
    }
    assert.deepEqual(lintSprint(snapshot([]), historyOf([late]), config, jst('2026-10-30T15:00:00')).map((f) => f.rule), ['S-CHECKPOINT'])
    assert.match(lintSprint(snapshot([]), historyOf([late]), config, jst('2026-10-30T15:00:00'))[0]?.message ?? '', /Recorded checkpoint 13:00 \(recorded late, at 14:30\)/)
    assert.deepEqual(lintSprint(snapshot([]), historyOf([late]), config, jst('2026-10-30T15:31:00')), [])
  })

  it('sprint の設定が無ければ何も出さない', () => {
    const { sprint: _s, ...plain } = config
    assert.deepEqual(lintSprint(snapshot([doing(1)]), historyOf(), plain, NOW), [])
  })
})

describe('節目の記録', () => {
  it('作業中の issue ごとに、ポイント・手間・超過・止まっている理由を残す', () => {
    const record = buildRecord(snapshot([doing(1, { points: 3 }), issue(2)]), historyOf(), config, jst('2026-10-30T13:00:00'), NOW)
    assert.equal(record.scheduledFor, jst('2026-10-30T13:00:00').toISOString())
    assert.equal(record.snapshotAt, snapshot([]).fetchedAt)
    assert.deepEqual(record.items, [
      { label: 'app#1', points: 3, budget: 2, effort: 4, over: 2, overSince: jst('2026-10-30T08:00:00').toISOString(), reason: 'None', assignee: 'SWE1' },
    ])
  })

  it('まだ記録していない最後の節目を返し、記録済みなら null', () => {
    const due = dueCheckpoint([], config, NOW)
    assert.equal(due?.toISOString(), jst('2026-10-30T13:00:00').toISOString())
    const done: CheckpointRecord = { scheduledFor: due?.toISOString() ?? '', recordedAt: NOW.toISOString(), items: [] }
    assert.equal(dueCheckpoint([done], config, NOW), null)
  })
})

describe('組み込み', async () => {
  const { lintAll } = await import('../src/findings/lint.ts')
  const { formatStatusline } = await import('../src/findings/format.ts')
  const { formatPoints } = await import('../src/sprint/report.ts')

  it('lintAll は、節目の記録を使って sprint の指摘も出す', () => {
    const ctx = { snapshot: { ...snapshot([doing(1, { points: 3 })]), fetchedAt: NOW.toISOString() }, members: [], acks: [], config, now: NOW, checkpoints: [] }
    assert.deepEqual(lintAll(ctx).active.map((f) => f.rule), ['S-POINTS-OVER'])
  })

  it('statusline に超過の件数を出す', () => {
    const [over] = lintSprint(snapshot([doing(1, { points: 3 })]), historyOf(), config, NOW)
    assert.equal(formatStatusline(over === undefined ? [] : [over]), '⚠ board high 0 medium 0 │ overrun 1')
  })

  it('scrum points は作業中の issue を、超えた順に表で出す', () => {
    const text = formatPoints(snapshot([doing(1, { points: 8 }), doing(2, { points: 3 }), doing(3)]), historyOf(), config, NOW)
    const lines = text.split('\n')
    assert.equal(lines[0], 'issue\tpoints\tbudget\teffort\toverrun\tblocked reason\tassignee')
    assert.equal(lines[1], 'app#2\t3\t2\t4\t+2\tNone\tSWE1')
    assert.equal(lines[2], 'app#1\t8\t5\t4\t0\tNone\tSWE1')
    assert.equal(lines[3], 'app#3\t-\t-\t4\t-\tNone\tSWE1')
    assert.match(lines.at(-1) ?? '', /Next checkpoint: 21:00/)
  })

  it('scrum points の手間は、節目の記録で止まっていた節目を除く', () => {
    const record: CheckpointRecord = {
      scheduledFor: jst('2026-10-29T21:00:00').toISOString(),
      recordedAt: jst('2026-10-29T21:01:00').toISOString(),
      items: [{ label: 'app#2', points: 3, budget: 2, effort: 2, over: 0, reason: 'Needs decision', assignee: 'SWE1' }],
    }
    const text = formatPoints(snapshot([doing(2, { points: 3 })]), historyOf([record]), config, NOW)
    assert.equal(text.split('\n')[1], 'app#2\t3\t2\t3\t+1\tNone\tSWE1')
  })
})
