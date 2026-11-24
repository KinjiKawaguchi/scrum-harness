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
  sprint: { checkpoints: ['08:00', '13:00', '21:00'], utcOffset: '+09:00', pointsField: 'ストーリーポイント', overrunField: '超過', pointBudgets: { '1': 1, '2': 1, '3': 2, '5': 3, '8': 5 } },
}
const jst = (text: string) => new Date(`${text}+09:00`)
/** 10/29 09:00 から作業中。またいだ節目は 13:00、21:00、10/30 08:00、13:00。ポイント 3 (目安 2) の超過を出したのは、10/30 08:00 */
const NOW = jst('2026-10-30T14:00:00')
const doingSince = [{ at: jst('2026-10-29T09:00:00').toISOString(), status: '作業中' }]
const mark = (decision: string, from: number, to: number) => `<!-- scrum:points-overrun decision=${decision} from=${from} to=${to} -->\nTechLead: 理由の 1 行`
const AFTER = jst('2026-10-30T09:00:00').toISOString()
const BEFORE = jst('2026-10-30T07:00:00').toISOString()

function setup(points = 3) {
  const p = paths(mkdtempSync(join(tmpdir(), 'scrum-overrun-')))
  writeJson(p.snapshot, snapshot([issue(1, { status: '作業中', tanto: 'SWE1', points, statusEvents: doingSince })]))
  return p
}
const ack = (p: ReturnType<typeof paths>, comments: () => readonly IssueComment[], subject = 'app#1') =>
  ackCommand(p, ['S-POINTS-OVER', subject], { for: '1d', reason: '08:00 の振り返りで決める' }, config, NOW, comments)
const comments = (...list: readonly IssueComment[]) => () => list
const written = (p: ReturnType<typeof paths>) => readJson<readonly Ack[]>(p.acks, [])

describe('scrum ack S-POINTS-OVER', () => {
  it('超過を出した節目より後の印があれば、受け入れて、根拠を残す', () => {
    const p = setup()
    const text = ack(p, comments({ body: mark('split', 3, 3), createdAt: AFTER, url: 'https://example.invalid/c/1' }))
    assert.match(text, /^受け入れた: S-POINTS-OVER app#1/)
    assert.equal(written(p)[0]?.basis, 'decision=split from=3 to=3 (https://example.invalid/c/1)')
  })

  it('印が無ければ、受け入れず、何も書かない。メッセージに、印の書き方を出す', () => {
    const p = setup()
    const text = ack(p, comments({ body: '振り返りで見積もりを直す', createdAt: AFTER }))
    assert.match(text, /^S-POINTS-OVER は、見積もりを直す、分ける、手を足す、見積もりのままにすると決めた記録/)
    assert.match(text, /scrum:points-overrun decision=/)
    assert.deepEqual(written(p), [])
  })

  it('超過を出した節目より前の印は、使わない', () => {
    const p = setup()
    assert.match(ack(p, comments({ body: mark('keep', 3, 3), createdAt: BEFORE })), /超過を出した節目 \(2026-10-29T23:00:00\.000Z\) より後に付いた/)
    assert.deepEqual(written(p), [])
  })

  it('reestimate の印は、ボードのポイントが to に直っていなければ、受け入れない。直っていれば受け入れる', () => {
    const stale = setup(3)
    assert.match(ack(stale, comments({ body: mark('reestimate', 3, 5), createdAt: AFTER })), /to=5 と、ボードのポイント \(3\) が違う/)
    assert.deepEqual(written(stale), [])
    const fixed = setup(5)
    // ポイント 5 (目安 3) は、4 つの節目で 1 つ超え、超過を出した節目は 10/30 13:00。印はそれより後に付ける
    const text = ack(fixed, comments({ body: mark('reestimate', 3, 5), createdAt: jst('2026-10-30T13:30:00').toISOString() }))
    assert.match(text, /^受け入れた/)
    assert.match(written(fixed)[0]?.basis ?? '', /^decision=reestimate from=3 to=5/)
  })

  it('いま超過が出ていない issue と、控えに無い issue は、受け入れない', () => {
    const p = setup(8)
    assert.match(ack(p, comments({ body: mark('keep', 8, 8), createdAt: AFTER })), /いま S-POINTS-OVER は出ていない \(手間 4、目安 5\)/)
    assert.match(ack(p, comments(), 'app#99'), /app#99 が控えに無い/)
    assert.deepEqual(written(p), [])
  })

  it('issue のコメントを読めなければ、受け入れず、理由を出す', () => {
    const p = setup()
    const text = ack(p, () => {
      throw new Error('gh が落ちた')
    })
    assert.match(text, /コメントを読めなかったので、受け入れを記録しない: gh が落ちた/)
    assert.deepEqual(written(p), [])
  })

  it('sprint の設定が無ければ、受け入れない', () => {
    const p = setup()
    assert.match(ackCommand(p, ['S-POINTS-OVER', 'app#1'], { for: '1d', reason: 'x' }, null, NOW, comments()), /sprint の設定が無い/)
    assert.deepEqual(written(p), [])
  })

  it('S-POINTS-OVER 以外の受け入れは、印を求めない', () => {
    const p = setup()
    assert.match(ackCommand(p, ['B-BLOCK-STALE', 'app#12'], { for: '2h', reason: '今夜の作業待ち' }, config, NOW), /^受け入れた: B-BLOCK-STALE app#12/)
  })
})

describe('S-POINTS-OVER の受け入れが、指摘を消す条件', () => {
  const over = (snap: ReturnType<typeof snapshot>) => lintSprint(snap, historyOf(), config, NOW).filter((one) => one.rule === 'S-POINTS-OVER')
  const live = (extra: Partial<Ack> = {}): Ack => ({
    rule: 'S-POINTS-OVER',
    subject: 'app#1',
    until: jst('2026-10-31T00:00:00').toISOString(),
    reason: '振り返りで決める',
    at: NOW.toISOString(),
    ...extra,
  })

  it('根拠 (basis) の無い受け入れは、期限内でも指摘を消さない。根拠が付いていれば消す', () => {
    const findings = over(snapshot([issue(1, { status: '作業中', tanto: 'SWE1', points: 3, statusEvents: doingSince })]))
    assert.equal(findings.length, 1)
    assert.equal(applyAcks(findings, [live()], NOW).active.length, 1)
    assert.equal(applyAcks(findings, [live({ basis: 'decision=keep from=3 to=3' })], NOW).active.length, 0)
  })

  it('ほかの規則の受け入れは、根拠が無くても指摘を消す', () => {
    const finding = makeFinding({ rule: 'B-BLOCK-STALE', subject: 'app#1', severity: 'medium', message: 'x', fix: 'y' })
    assert.equal(applyAcks([finding], [live({ rule: 'B-BLOCK-STALE' })], NOW).active.length, 0)
  })

  it('scrum acks は、根拠を出す。根拠の無い S-POINTS-OVER の受け入れには、指摘が消えないと書く', () => {
    const p = setup()
    writeJson(p.acks, [live({ until: new Date(Date.now() + 3_600_000).toISOString(), basis: 'decision=keep from=2 to=2' }), live({ subject: 'app#2', until: new Date(Date.now() + 3_600_000).toISOString() })])
    const lines = acksCommand(p).split('\n')
    assert.match(lines[0] ?? '', /\(根拠: decision=keep from=2 to=2\)$/)
    assert.match(lines[1] ?? '', /\(超過の扱いを決めた記録が無いので、指摘は消えない\)$/)
    assert.equal(readFileSync(p.acks, 'utf8').includes('basis'), true)
  })
})
