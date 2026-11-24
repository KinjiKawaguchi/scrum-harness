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
  it('removes findings covered by an acknowledgement within its expiry', () => {
    const idle = finding('T-IDLE', 'SWE3', 'high')
    const other = finding('T-IDLE', 'SWE1', 'high')
    const result = applyAcks([idle, other], [ack()], NOW)
    assert.deepEqual(result.active, [other])
    assert.deepEqual(result.acked, [idle])
  })

  it('an expired acknowledgement has no effect', () => {
    const idle = finding('T-IDLE', 'SWE3', 'high')
    assert.deepEqual(applyAcks([idle], [ack({ until: '2026-10-08T05:59:00.000Z' })], NOW).active, [idle])
  })

  it('replaces an acknowledgement for the same target and discards expired ones', () => {
    const expired = ack({ subject: 'SWE1', until: '2026-10-08T01:00:00.000Z' })
    const next = addAck([ack(), expired], ack({ reason: 'Extended' }), NOW)
    assert.deepEqual(next.map((one) => `${one.subject} ${one.reason}`), ['SWE3 Extended'])
  })

  it('reads the duration notation', () => {
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

  it('returns only medium or higher findings that have not been announced', () => {
    assert.deepEqual(unseen([high, medium, low], [high.key], 'medium'), [medium])
  })

  it('limits the fingerprints it remembers to the findings that exist now', () => {
    assert.deepEqual(remember(['gone', high.key], [high, medium], [medium]), [high.key, medium.key].toSorted())
  })

  it('blocks Stop when there is a high finding that has not been announced', () => {
    assert.deepEqual(decideStop([high], [], false), { shouldBlock: true, keys: [high.key] })
  })

  it('does not block twice for the same combination', () => {
    assert.equal(decideStop([high], [high.key], false).shouldBlock, false)
  })

  it('does not block in a turn that continues through the Stop hook', () => {
    assert.equal(decideStop([high], [], true).shouldBlock, false)
  })
})

describe('format', () => {
  it('puts severity, rule, and fix on one line', () => {
    const [line] = formatList([finding('B-CLOSED-NOT-DONE', 'app#7')], 5)
    assert.equal(line, '- [medium] B-CLOSED-NOT-DONE app#7 finding → fix app#7')
  })

  it('writes only the count for the part beyond the limit', () => {
    const lines = formatList(['a', 'b', 'c'].map((s) => finding('R', s)), 2)
    assert.match(lines.at(-1) ?? '', /^- 1 more \(.*scrum lint for all\)$/)
  })

  it('the summary shows the count per rule and the count of acknowledged findings', () => {
    const text = formatSummary([finding('B-CLOSED-NOT-DONE', 'app#7'), finding('B-CLOSED-NOT-DONE', 'app#8')], 1)
    assert.match(text, /medium 2/)
    assert.match(text, /B-CLOSED-NOT-DONE x2/)
    assert.match(text, /1 acknowledged/)
  })

  it('the statusline briefly shows the counts of high and medium findings and the idle members', () => {
    const idle = makeFinding({ rule: 'T-IDLE', subject: 'SWE3', severity: 'high', message: 'SWE3 has been idle for 55 minutes. …', minutes: 55 })
    assert.equal(formatStatusline([idle, finding('B-X', 'app#1')]), '⚠ board high 0 medium 1 │ idle SWE3 55m')
  })

  it('when there are no findings, the statusline shows OK', () => {
    assert.equal(formatStatusline([]), '✓ board OK')
  })
})

describe('staleness of the board copy in lintAll', async () => {
  const { lintAll } = await import('../src/findings/lint.ts')
  const { config, snapshot } = await import('./helpers.ts')
  const base = { members: [], acks: [], config, now: NOW }

  it('emits B-SNAPSHOT-STALE when the board copy is older than 3 times refreshSeconds', () => {
    const old = { ...snapshot([]), fetchedAt: new Date(NOW.getTime() - 16 * 60_000).toISOString() }
    const { active } = lintAll({ ...base, snapshot: old })
    assert.deepEqual(active.map((f) => `${f.rule} ${f.severity}`), ['B-SNAPSHOT-STALE medium'])
    assert.match(active[0]?.message ?? '', /16 minutes ago/)
  })

  it('does not emit when the board copy is fresh', () => {
    const fresh = { ...snapshot([]), fetchedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() }
    assert.deepEqual(lintAll({ ...base, snapshot: fresh }).active, [])
  })

  it('does not emit when there is no board copy yet (the summary says it is being fetched)', () => {
    assert.deepEqual(lintAll({ ...base, snapshot: null }).active, [])
  })
})
