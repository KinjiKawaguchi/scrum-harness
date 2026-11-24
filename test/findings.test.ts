import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addAck, applyAcks, parseDuration, type Ack } from '../src/findings/acks.ts'
import { formatList, formatStatusline, formatSummary } from '../src/findings/format.ts'
import { decideStop, remember, unseen } from '../src/findings/notify.ts'
import { makeFinding, type Finding, type Severity } from '../src/findings/types.ts'
import { NOW } from './helpers.ts'

function finding(rule: string, subject: string, severity: Severity = 'medium'): Finding {
  return makeFinding({ rule, subject, severity, message: `${subject} finding`, fix: `fix ${subject}` })
}

const ack = (overrides: Partial<Ack> = {}): Ack => ({
  rule: 'T-IDLE',
  subject: 'SWE3',
  until: '2026-10-08T08:00:00.000Z',
  reason: 'Waiting for the night run',
  at: '2026-10-08T05:00:00.000Z',
  ...overrides,
})

describe('acks', () => {
  it('期限内の受け入れに当たる指摘を外す', () => {
    const idle = finding('T-IDLE', 'SWE3', 'high')
    const other = finding('T-IDLE', 'SWE1', 'high')
    const result = applyAcks([idle, other], [ack()], NOW)
    assert.deepEqual(result.active, [other])
    assert.deepEqual(result.acked, [idle])
  })

  it('期限の切れた受け入れは効かない', () => {
    const idle = finding('T-IDLE', 'SWE3', 'high')
    assert.deepEqual(applyAcks([idle], [ack({ until: '2026-10-08T05:59:00.000Z' })], NOW).active, [idle])
  })

  it('同じ対象の受け入れを置き換え、切れたものを捨てる', () => {
    const expired = ack({ subject: 'SWE1', until: '2026-10-08T01:00:00.000Z' })
    const next = addAck([ack(), expired], ack({ reason: 'Extended' }), NOW)
    assert.deepEqual(next.map((one) => `${one.subject} ${one.reason}`), ['SWE3 Extended'])
  })

  it('期間の書き方を読む', () => {
    assert.equal(parseDuration('30m'), 30 * 60_000)
    assert.equal(parseDuration('2h'), 2 * 3_600_000)
    assert.equal(parseDuration('1d'), 86_400_000)
    assert.equal(parseDuration('soon'), null)
  })
})

describe('notify', () => {
  const high = finding('B-DOING-NO-ASSIGNEE', 'app#5', 'high')
  const medium = finding('B-CLOSED-NOT-DONE', 'app#7')
  const low = finding('B-SINCE-STRAY', 'app#9', 'low')

  it('知らせていない中以上の指摘だけを返す', () => {
    assert.deepEqual(unseen([high, medium, low], [high.key], 'medium'), [medium])
  })

  it('覚える指紋は今ある指摘に絞る', () => {
    assert.deepEqual(remember(['gone', high.key], [high, medium], [medium]), [high.key, medium.key].toSorted())
  })

  it('知らせていない高い指摘があれば Stop を止める', () => {
    assert.deepEqual(decideStop([high], [], false), { shouldBlock: true, keys: [high.key] })
  })

  it('同じ組み合わせでは二度止めない', () => {
    assert.equal(decideStop([high], [high.key], false).shouldBlock, false)
  })

  it('Stop フックで続いているターンでは止めない', () => {
    assert.equal(decideStop([high], [], true).shouldBlock, false)
  })
})

describe('format', () => {
  it('重さ・規則・直し方を1行にする', () => {
    const [line] = formatList([finding('B-CLOSED-NOT-DONE', 'app#7')], 5)
    assert.equal(line, '- [medium] B-CLOSED-NOT-DONE app#7 finding → fix app#7')
  })

  it('上限を超えた分は件数だけ書く', () => {
    const lines = formatList(['a', 'b', 'c'].map((s) => finding('R', s)), 2)
    assert.match(lines.at(-1) ?? '', /^- 1 more \(.*scrum lint for all\)$/)
  })

  it('要約に規則ごとの件数と受け入れ済みの件数を出す', () => {
    const text = formatSummary([finding('B-CLOSED-NOT-DONE', 'app#7'), finding('B-CLOSED-NOT-DONE', 'app#8')], 1)
    assert.match(text, /medium 2/)
    assert.match(text, /B-CLOSED-NOT-DONE x2/)
    assert.match(text, /1 acknowledged/)
  })

  it('statusline は高と中の件数と空いている部下を短く出す', () => {
    const idle = makeFinding({ rule: 'T-IDLE', subject: 'SWE3', severity: 'high', message: 'SWE3 has been idle for 55 minutes. …', minutes: 55 })
    assert.equal(formatStatusline([idle, finding('B-X', 'app#1')]), '⚠ board high 0 medium 1 │ idle SWE3 55m')
  })

  it('指摘が無ければ statusline は OK を出す', () => {
    assert.equal(formatStatusline([]), '✓ board OK')
  })
})

describe('lintAll の控えの古さ', async () => {
  const { lintAll } = await import('../src/findings/lint.ts')
  const { config, snapshot } = await import('./helpers.ts')
  const base = { members: [], acks: [], config, now: NOW }

  it('控えが refreshSeconds の3倍より古ければ B-SNAPSHOT-STALE を出す', () => {
    const old = { ...snapshot([]), fetchedAt: new Date(NOW.getTime() - 16 * 60_000).toISOString() }
    const { active } = lintAll({ ...base, snapshot: old })
    assert.deepEqual(active.map((f) => `${f.rule} ${f.severity}`), ['B-SNAPSHOT-STALE medium'])
    assert.match(active[0]?.message ?? '', /16 minutes ago/)
  })

  it('控えが新しければ出さない', () => {
    const fresh = { ...snapshot([]), fetchedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() }
    assert.deepEqual(lintAll({ ...base, snapshot: fresh }).active, [])
  })

  it('控えがまだ無いときは出さない (取得中と要約で伝える)', () => {
    assert.deepEqual(lintAll({ ...base, snapshot: null }).active, [])
  })
})
