import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ackCommand, pointsCommand } from '../src/cli-commands.ts'
import type { Config } from '../src/config.ts'
import { lintAll, loadContext } from '../src/findings/lint.ts'
import { assessItem } from '../src/sprint/assess.ts'
import { recordDueCheckpoint } from '../src/sprint/checkpoint-run.ts'
import { recordCompletions } from '../src/sprint/completion.ts'
import { loadCountingHistory } from '../src/sprint/counting-history.ts'
import type { IssueComment } from '../src/sprint/overrun-mark.ts'
import { buildRecord } from '../src/sprint/record.ts'
import { formatPoints } from '../src/sprint/report.ts'
import { lintSprint } from '../src/sprint/rules.ts'
import { activityTimes, loadTeamStop, stoppedSpans, teamStopFrom, TEAM_STOP_MS } from '../src/sprint/team-stop.ts'
import { appendLine, paths, writeJson } from '../src/store.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, historyOf, issue, snapshot } from './helpers.ts'

const config: Config = {
  ...base,
  sprint: { checkpoints: ['08:00', '13:00', '21:00'], utcOffset: '+09:00', pointsField: 'Story points', overrunField: 'Overrun', pointBudgets: { '1': 1, '2': 1, '3': 2, '5': 3, '8': 5 } },
}
const jst = (text: string) => new Date(`${text}+09:00`)
const MINUTE = 60_000
/** 10/29 09:00 から作業中、10/30 14:00 が今。またいだ節目は C1 (10/29 13:00)、C2 (21:00)、C3 (10/30 08:00)、C4 (13:00) */
const NOW = jst('2026-10-30T14:00:00')
const C1 = jst('2026-10-29T13:00:00')
const C2 = jst('2026-10-29T21:00:00')
const C3 = jst('2026-10-30T08:00:00')
const C4 = jst('2026-10-30T13:00:00')
const doingSince = [{ at: jst('2026-10-29T09:00:00').toISOString(), status: config.statuses.doing }]
const doing = (overrides: Parameters<typeof issue>[1] = {}) => issue(1, { status: config.statuses.doing, assignee: 'SWE1', points: 3, statusEvents: doingSince, ...overrides })
const stopAt = (...times: readonly Date[]) => (at: Date) => times.some((time) => time.getTime() === at.getTime())
const eventLine = (type: string, at: Date) => JSON.stringify({ at: at.toISOString(), type, name: 'SWE1', from: 'idle', to: 'busy', minutes: 1 })
/** 10/29 08:00 と、15:00 から今まで 1 時間おきの動き。C1 (13:00) だけが、7 時間の抜けの内側に入る */
function writeActivityWithGapAtC1(p: ReturnType<typeof paths>): void {
  appendLine(p.events, eventLine('member-state', jst('2026-10-29T08:00:00')))
  Array.from({ length: 24 }, (_, hour) => jst('2026-10-29T15:00:00').getTime() + hour * 60 * MINUTE).forEach((at) =>
    appendLine(p.events, eventLine('member-state', new Date(at))),
  )
}
const setup = () => paths(mkdtempSync(join(tmpdir(), 'scrum-team-stop-')))

describe('activityTimes', () => {
  it('チームの誰かが動いた 5 種類だけを、古い順に返す。指摘の開閉と、読めない行は捨てる', () => {
    const text = [
      eventLine('woke', new Date(3000)),
      eventLine('member-state', new Date(1000)),
      eventLine('finding-opened', new Date(500)),
      eventLine('finding-closed', new Date(600)),
      eventLine('dispatched', new Date(700)),
      JSON.stringify({ at: new Date(5000).toISOString(), type: 'activity', role: 'member' }),
      eventLine('stop-blocked', new Date(4000)),
      'broken line',
      JSON.stringify({ type: 'acked' }),
      JSON.stringify({ at: 'not a date', type: 'acked' }),
      eventLine('acked', new Date(2000)),
      '',
    ].join('\n')
    assert.deepEqual(activityTimes(text), [1000, 2000, 3000, 4000, 5000])
  })
})

describe('stoppedSpans', () => {
  const at = (minutes: number) => minutes * MINUTE
  it('動きの記録が 120 分以上途切れた期間だけを返す。ちょうど 120 分は含み、1 ミリ秒足りなければ含めない', () => {
    const times = [at(0), at(120), at(120) + at(120) - 1]
    assert.deepEqual(stoppedSpans(times, new Date(at(241)), TEAM_STOP_MS), [{ start: at(0), end: at(120) }])
  })

  it('最後の動きから今までも、120 分以上なら含める。足りなければ含めない', () => {
    assert.deepEqual(stoppedSpans([at(0)], new Date(at(120))), [{ start: at(0), end: at(120) }])
    assert.deepEqual(stoppedSpans([at(0)], new Date(at(120) - 1)), [])
  })

  it('動きの記録が 1 件も無ければ、何も言えないので空を返す', () => {
    assert.deepEqual(stoppedSpans([], new Date(at(100_000))), [])
  })
})

describe('teamStopFrom', () => {
  it('止まっていた期間の内側の時刻は止まっていたとし、両端と外側はそうしない', () => {
    const isStopped = teamStopFrom([{ start: 1000, end: 2000 }])
    assert.deepEqual([999, 1000, 1001, 1999, 2000, 2001].map((time) => isStopped(new Date(time))), [false, false, true, true, false, false])
  })
})

describe('loadTeamStop', () => {
  it('events.jsonl の動きの抜けから作る。抜けの間に指摘の開閉があっても、止まっていたとする', () => {
    const p = setup()
    appendLine(p.events, eventLine('member-state', jst('2026-10-29T08:00:00')))
    appendLine(p.events, eventLine('finding-opened', jst('2026-10-29T12:00:00')))
    appendLine(p.events, eventLine('member-state', jst('2026-10-29T15:00:00')))
    const isStopped = loadTeamStop(p, jst('2026-10-29T15:30:00'))
    assert.equal(isStopped(C1), true)
    assert.equal(isStopped(jst('2026-10-29T15:10:00')), false)
  })

  it('watch が書く記録が無い間も、フックの activity が 10 分おきにあれば、止まりにしない', () => {
    const p = setup()
    appendLine(p.events, eventLine('member-state', jst('2026-10-29T08:00:00')))
    Array.from({ length: 42 }, (_, index) => jst('2026-10-29T08:10:00').getTime() + index * 10 * MINUTE).forEach((at) =>
      appendLine(p.events, JSON.stringify({ at: new Date(at).toISOString(), type: 'activity', role: 'member' })),
    )
    appendLine(p.events, eventLine('member-state', jst('2026-10-29T15:10:00')))
    assert.equal(loadTeamStop(p, jst('2026-10-29T15:30:00'))(C1), false)
  })

  it('loadCountingHistory は、いまの時刻を止まりの判定に使う (最後の動きから 119 分後は止まりでなく、121 分後は止まり)', () => {
    const p = setup()
    const last = jst('2026-10-29T09:00:00')
    appendLine(p.events, eventLine('member-state', last))
    const during = new Date(last.getTime() + 60 * MINUTE)
    assert.equal(loadCountingHistory(p, new Date(last.getTime() + 119 * MINUTE)).teamStop(during), false)
    assert.equal(loadCountingHistory(p, new Date(last.getTime() + 121 * MINUTE)).teamStop(during), true)
  })

  it('events.jsonl が無ければ、止まっていたとはしない', () => {
    assert.equal(loadTeamStop(setup(), NOW)(C1), false)
  })
})

describe('assessItem と全セッションが止まっていた節目', () => {
  it('その節目を手間から除き、超過を出した節目は後ろにずれ、除いた数を出す', () => {
    const one = assessItem(doing(), historyOf([], stopAt(C1)), config, NOW)
    assert.equal(one.effort, 3)
    assert.equal(one.over, 1)
    assert.equal(one.overSince, C4.toISOString())
    assert.equal(one.teamStopped, 1)
    const two = assessItem(doing(), historyOf([], stopAt(C1, C2)), config, NOW)
    assert.deepEqual([two.effort, two.over, two.overSince, two.teamStopped], [2, 0, null, 2])
  })

  it('理由で止まっていて除いた節目と重なる分は、除いた数に入れない', () => {
    const blocked = doing({ reason: 'External wait', since: '2026-10-30' })
    const one = assessItem(blocked, historyOf([], stopAt(C1, C4)), config, NOW)
    assert.deepEqual([one.effort, one.teamStopped], [1, 1])
  })

  it('除いた節目が無ければ、除いた数の項目を持たない', () => {
    assert.equal('teamStopped' in assessItem(doing(), historyOf([], stopAt(jst('2026-10-01T00:00:00'))), config, NOW), false)
    assert.equal('teamStopped' in assessItem(doing(), historyOf(), config, NOW), false)
  })
})

describe('S-POINTS-OVER の文', () => {
  const over = (stop?: (at: Date) => boolean) =>
    lintSprint(snapshot([doing()]), historyOf([], stop), config, NOW).filter((one) => one.rule === 'S-POINTS-OVER')

  it('全セッションが止まっていて除いた節目があれば、「除いた節目 n」を出す', () => {
    const [finding] = over(stopAt(C1))
    assert.match(finding?.message ?? '', /\(budget 2 checkpoints\) \(\+1\)\. Checkpoints with a block are excluded\. Checkpoints excluded because all sessions were stopped: 1$/)
  })

  it('除いた節目が無ければ、書かない', () => {
    const [finding] = over()
    assert.doesNotMatch(finding?.message ?? '', /excluded because all sessions were stopped/)
  })
})

describe('止まっていた節目を使う 5 つの経路は、どれも events.jsonl の抜けを読む', () => {
  it('節目の記録 (buildRecord に渡す)。記録した時点の手間と、除いた節目を残す', () => {
    const record = buildRecord(snapshot([doing()]), historyOf([], stopAt(C1)), config, C4, NOW)
    assert.deepEqual([record.items[0]?.effort, record.items[0]?.teamStopped], [3, 1])
  })

  it('節目の記録 (recordDueCheckpoint が events.jsonl から読む)', () => {
    const p = setup()
    writeActivityWithGapAtC1(p)
    const record = recordDueCheckpoint(p, config, snapshot([doing()]), NOW, () => undefined)
    assert.deepEqual([record?.items[0]?.effort, record?.items[0]?.teamStopped], [3, 1])
  })

  it('scrum points の表 (formatPoints)', () => {
    const text = formatPoints(snapshot([doing()]), historyOf([], stopAt(C1, C2)), config, NOW, [])
    assert.match(text, /\napp#1\t3\t2\t2 \(excluded checkpoints 2\)\t0\t/)
    assert.match(text, /Checkpoints with a block and checkpoints where all sessions were stopped are excluded/)
  })

  it('scrum points (pointsCommand が events.jsonl から読む)', () => {
    const p = setup()
    appendLine(p.events, eventLine('member-state', jst('2026-10-29T10:00:00')))
    writeJson(p.snapshot, snapshot([doing()]))
    assert.match(pointsCommand(p, config), /\napp#1\t3\t2\t0 \(excluded checkpoints \d+\)\t0\t/)
  })

  it('S-POINTS-OVER の指摘 (loadContext と lintAll が events.jsonl から読む)', () => {
    const p = setup()
    writeActivityWithGapAtC1(p)
    const found = lintAll(loadContext(p, config, NOW, fakePorts().sessions, snapshot([doing()]))).active.filter((one) => one.rule === 'S-POINTS-OVER')
    assert.match(found[0]?.message ?? '', /Checkpoints excluded because all sessions were stopped: 1$/)
  })

  it('受け入れ (scrum ack S-POINTS-OVER) は、指摘と同じ数えで、超過を出した節目を決める', () => {
    const p = setup()
    writeActivityWithGapAtC1(p)
    writeJson(p.snapshot, snapshot([doing()]))
    const mark = '<!-- scrum:points-overrun decision=keep from=3 to=3 -->\nTechLead: one line of reasoning'
    const ack = (createdAt: Date) =>
      ackCommand(p, ['S-POINTS-OVER', 'app#1'], { for: '1d', reason: 'decide in the review' }, config, NOW, { comments: () => [{ body: mark, createdAt: createdAt.toISOString() } satisfies IssueComment] })
    // 止まっていた C1 を除くと、超過を出した節目は C3 (08:00) でなく C4 (13:00)。C3 と C4 の間の印は使えない
    assert.match(ack(new Date(C3.getTime() + 60 * MINUTE)), new RegExp(`added after the checkpoint that showed the overrun \\(${C4.toISOString().replaceAll('.', '\\.')}\\)`))
    assert.match(ack(new Date(C4.getTime() + 30 * MINUTE)), /^Acknowledged: S-POINTS-OVER app#1/)
  })

  it('済んだ issue の記録 (recordCompletions が events.jsonl から読む)', () => {
    const p = setup()
    writeActivityWithGapAtC1(p)
    const previous = snapshot([doing()])
    const fresh = snapshot([issue(1, { status: config.statuses.done, points: 3 })])
    const timeline = [...doingSince, { at: jst('2026-10-30T13:50:00').toISOString(), status: config.statuses.done }]
    const [one] = recordCompletions(p, previous, fresh, config, NOW, () => new Map([['app#1', timeline]]))
    assert.equal(one?.effort, 3)
  })
})
