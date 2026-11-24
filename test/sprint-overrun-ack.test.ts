import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ackCommand, acksCommand } from '../src/cli-commands.ts'
import type { Config } from '../src/config.ts'
import { applyAcks, type Ack } from '../src/findings/acks.ts'
import { makeFinding } from '../src/findings/types.ts'
import { lintSprint } from '../src/sprint/rules.ts'
import type { IssueComment } from '../src/sprint/overrun-mark.ts'
import { paths, readJson, writeJson } from '../src/store.ts'
import { config as base, historyOf, issue, snapshot } from './helpers.ts'

const config: Config = {
  ...base,
  sprint: { checkpoints: ['08:00', '13:00', '21:00'], utcOffset: '+09:00', pointsField: 'Story points', overrunField: 'Overrun', pointBudgets: { '1': 1, '2': 1, '3': 2, '5': 3, '8': 5 } },
}
const jst = (text: string) => new Date(`${text}+09:00`)
/** In Progress since 10/29 09:00. The checkpoints crossed are 13:00, 21:00, 10/30 08:00, and 13:00. The overrun for 3 points (budget 2) was reported at 10/30 08:00 */
const NOW = jst('2026-10-30T14:00:00')
const doingSince = [{ at: jst('2026-10-29T09:00:00').toISOString(), status: 'In Progress' }]
const mark = (decision: string, from: number, to: number) => `<!-- scrum:points-overrun decision=${decision} from=${from} to=${to} -->\nTechLead: one line of reasoning`
const AFTER = jst('2026-10-30T09:00:00').toISOString()
const BEFORE = jst('2026-10-30T07:00:00').toISOString()

function setup(points = 3) {
  const p = paths(mkdtempSync(join(tmpdir(), 'scrum-overrun-')))
  writeJson(p.snapshot, snapshot([issue(1, { status: 'In Progress', assignee: 'SWE1', points, statusEvents: doingSince })]))
  return p
}
const ack = (p: ReturnType<typeof paths>, comments: () => readonly IssueComment[], subject = 'app#1') =>
  ackCommand(p, ['S-POINTS-OVER', subject], { for: '1d', reason: 'decide in the 08:00 review' }, config, NOW, { comments })
const comments = (...list: readonly IssueComment[]) => () => list
const written = (p: ReturnType<typeof paths>) => readJson<readonly Ack[]>(p.acks, [])

describe('scrum ack S-POINTS-OVER', () => {
  it('when a marker later than the checkpoint that reported the overrun exists, accepts and keeps the basis', () => {
    const p = setup()
    const text = ack(p, comments({ body: mark('split', 3, 3), createdAt: AFTER, url: 'https://example.invalid/c/1' }))
    assert.match(text, /^Acknowledged: S-POINTS-OVER app#1/)
    assert.equal(written(p)[0]?.basis, 'decision=split from=3 to=3 (https://example.invalid/c/1)')
  })

  it('when there is no marker, does not accept and writes nothing; shows how to write the marker in the message', () => {
    const p = setup()
    const text = ack(p, comments({ body: 'Revise the estimate in the review', createdAt: AFTER }))
    assert.match(text, /^An S-POINTS-OVER acknowledgement is not accepted until a record is added/)
    assert.match(text, /scrum:points-overrun decision=/)
    assert.deepEqual(written(p), [])
  })

  it('does not use a marker earlier than the checkpoint that reported the overrun', () => {
    const p = setup()
    assert.match(ack(p, comments({ body: mark('keep', 3, 3), createdAt: BEFORE })), /added after the checkpoint that showed the overrun \(2026-10-29T23:00:00\.000Z\)/)
    assert.deepEqual(written(p), [])
  })

  it("does not accept a reestimate marker unless the board's points were fixed to to; accepts it when they were", () => {
    const stale = setup(3)
    assert.match(ack(stale, comments({ body: mark('reestimate', 3, 5), createdAt: AFTER })), /to=5 differs from the points on the board \(3\)/)
    assert.deepEqual(written(stale), [])
    const fixed = setup(5)
    // 5 points (budget 3) exceed the budget by one over four checkpoints, and the checkpoint that reported the overrun is 10/30 13:00. The marker is placed after it
    const text = ack(fixed, comments({ body: mark('reestimate', 3, 5), createdAt: jst('2026-10-30T13:30:00').toISOString() }))
    assert.match(text, /^Acknowledged/)
    assert.match(written(fixed)[0]?.basis ?? '', /^decision=reestimate from=3 to=5/)
  })

  it('does not accept for an issue with no overrun now or one not in the board copy', () => {
    const p = setup(8)
    assert.match(ack(p, comments({ body: mark('keep', 8, 8), createdAt: AFTER })), /has no S-POINTS-OVER now \(effort 4, budget 5\)/)
    assert.match(ack(p, comments(), 'app#99'), /app#99 is not in the board copy/)
    assert.deepEqual(written(p), [])
  })

  it("when the issue's comments cannot be read, does not accept and shows the reason", () => {
    const p = setup()
    const text = ack(p, () => {
      throw new Error('gh crashed')
    })
    assert.match(text, /Could not read the comments of the issue \S+, so the acknowledgement is not recorded: gh crashed/)
    assert.deepEqual(written(p), [])
  })

  it('does not accept when there is no sprint config', () => {
    const p = setup()
    assert.match(ackCommand(p, ['S-POINTS-OVER', 'app#1'], { for: '1d', reason: 'x' }, null, NOW, { comments: comments() }), /There is no sprint configuration/)
    assert.deepEqual(written(p), [])
  })

  it('acknowledgements other than S-POINTS-OVER do not ask for a marker', () => {
    const p = setup()
    assert.match(ackCommand(p, ['B-BLOCK-STALE', 'app#12'], { for: '2h', reason: 'Waiting for the night run' }, config, NOW), /^Acknowledged: B-BLOCK-STALE app#12/)
  })
})

describe('the condition under which an S-POINTS-OVER acknowledgement clears the finding', () => {
  const over = (snap: ReturnType<typeof snapshot>) => lintSprint(snap, historyOf(), config, NOW).filter((one) => one.rule === 'S-POINTS-OVER')
  const live = (extra: Partial<Ack> = {}): Ack => ({
    rule: 'S-POINTS-OVER',
    subject: 'app#1',
    until: jst('2026-10-31T00:00:00').toISOString(),
    reason: 'decide in the review',
    at: NOW.toISOString(),
    ...extra,
  })

  it('an acknowledgement without a basis does not clear the finding even within its expiry; one with a basis clears it', () => {
    const findings = over(snapshot([issue(1, { status: 'In Progress', assignee: 'SWE1', points: 3, statusEvents: doingSince })]))
    assert.equal(findings.length, 1)
    assert.equal(applyAcks(findings, [live()], NOW).active.length, 1)
    assert.equal(applyAcks(findings, [live({ basis: 'decision=keep from=3 to=3' })], NOW).active.length, 0)
  })

  it('an acknowledgement of another rule clears the finding even without a basis', () => {
    const finding = makeFinding({ rule: 'B-BLOCK-STALE', subject: 'app#1', severity: 'medium', message: 'x', fix: 'y' })
    assert.equal(applyAcks([finding], [live({ rule: 'B-BLOCK-STALE' })], NOW).active.length, 0)
  })

  it('scrum acks shows the basis; for an S-POINTS-OVER acknowledgement without a basis, writes that the finding will not clear', () => {
    const p = setup()
    writeJson(p.acks, [live({ until: new Date(Date.now() + 3_600_000).toISOString(), basis: 'decision=keep from=2 to=2' }), live({ subject: 'app#2', until: new Date(Date.now() + 3_600_000).toISOString() })])
    const lines = acksCommand(p).split('\n')
    assert.match(lines[0] ?? '', /\(basis: decision=keep from=2 to=2\)$/)
    assert.match(lines[1] ?? '', /\(no record of how the overrun was handled, so the finding stays\)$/)
    assert.equal(readFileSync(p.acks, 'utf8').includes('basis'), true)
  })
})
