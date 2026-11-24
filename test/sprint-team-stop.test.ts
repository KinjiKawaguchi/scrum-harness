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
/** In Progress since 10/29 09:00, with 10/30 14:00 as the present. The checkpoints crossed are C1 (10/29 13:00), C2 (21:00), C3 (10/30 08:00), and C4 (13:00) */
const NOW = jst('2026-10-30T14:00:00')
const C1 = jst('2026-10-29T13:00:00')
const C2 = jst('2026-10-29T21:00:00')
const C3 = jst('2026-10-30T08:00:00')
const C4 = jst('2026-10-30T13:00:00')
const doingSince = [{ at: jst('2026-10-29T09:00:00').toISOString(), status: config.statuses.doing }]
const doing = (overrides: Parameters<typeof issue>[1] = {}) => issue(1, { status: config.statuses.doing, assignee: 'SWE1', points: 3, statusEvents: doingSince, ...overrides })
const stopAt = (...times: readonly Date[]) => (at: Date) => times.some((time) => time.getTime() === at.getTime())
const eventLine = (type: string, at: Date) => JSON.stringify({ at: at.toISOString(), type, name: 'SWE1', from: 'idle', to: 'busy', minutes: 1 })
/** Activity at 10/29 08:00, and then hourly from 15:00 to the present. Only C1 (13:00) falls inside the 7-hour gap */
function writeActivityWithGapAtC1(p: ReturnType<typeof paths>): void {
  appendLine(p.events, eventLine('member-state', jst('2026-10-29T08:00:00')))
  Array.from({ length: 24 }, (_, hour) => jst('2026-10-29T15:00:00').getTime() + hour * 60 * MINUTE).forEach((at) =>
    appendLine(p.events, eventLine('member-state', new Date(at))),
  )
}
const setup = () => paths(mkdtempSync(join(tmpdir(), 'scrum-team-stop-')))

describe('activityTimes', () => {
  it('returns only the 5 kinds of events where someone on the team moved, oldest first; drops finding open/close events and unreadable lines', () => {
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
  it('returns only gaps where the activity record is broken for 120 minutes or more; includes exactly 120 minutes and excludes a gap 1 millisecond short', () => {
    const times = [at(0), at(120), at(120) + at(120) - 1]
    assert.deepEqual(stoppedSpans(times, new Date(at(241)), TEAM_STOP_MS), [{ start: at(0), end: at(120) }])
  })

  it('includes the span from the last activity to now when it is 120 minutes or more; excludes it when short', () => {
    assert.deepEqual(stoppedSpans([at(0)], new Date(at(120))), [{ start: at(0), end: at(120) }])
    assert.deepEqual(stoppedSpans([at(0)], new Date(at(120) - 1)), [])
  })

  it('when there is no activity record at all, nothing can be said, so returns empty', () => {
    assert.deepEqual(stoppedSpans([], new Date(at(100_000))), [])
  })
})

describe('teamStopFrom', () => {
  it('a time inside a stalled period counts as stalled; the two ends and the outside do not', () => {
    const isStopped = teamStopFrom([{ start: 1000, end: 2000 }])
    assert.deepEqual([999, 1000, 1001, 1999, 2000, 2001].map((time) => isStopped(new Date(time))), [false, false, true, true, false, false])
  })
})

describe('loadTeamStop', () => {
  it('is built from the activity gaps in events.jsonl; counts as stalled even if a finding opened or closed within the gap', () => {
    const p = setup()
    appendLine(p.events, eventLine('member-state', jst('2026-10-29T08:00:00')))
    appendLine(p.events, eventLine('finding-opened', jst('2026-10-29T12:00:00')))
    appendLine(p.events, eventLine('member-state', jst('2026-10-29T15:00:00')))
    const isStopped = loadTeamStop(p, jst('2026-10-29T15:30:00'))
    assert.equal(isStopped(C1), true)
    assert.equal(isStopped(jst('2026-10-29T15:10:00')), false)
  })

  it("even while the record the watch writes is absent, does not count it as a stall if the hook's activity appears every 10 minutes", () => {
    const p = setup()
    appendLine(p.events, eventLine('member-state', jst('2026-10-29T08:00:00')))
    Array.from({ length: 42 }, (_, index) => jst('2026-10-29T08:10:00').getTime() + index * 10 * MINUTE).forEach((at) =>
      appendLine(p.events, JSON.stringify({ at: new Date(at).toISOString(), type: 'activity', role: 'member' })),
    )
    appendLine(p.events, eventLine('member-state', jst('2026-10-29T15:10:00')))
    assert.equal(loadTeamStop(p, jst('2026-10-29T15:30:00'))(C1), false)
  })

  it('loadCountingHistory uses the current time to judge a stall (119 minutes after the last activity is not a stall, 121 minutes is)', () => {
    const p = setup()
    const last = jst('2026-10-29T09:00:00')
    appendLine(p.events, eventLine('member-state', last))
    const during = new Date(last.getTime() + 60 * MINUTE)
    assert.equal(loadCountingHistory(p, new Date(last.getTime() + 119 * MINUTE)).teamStop(during), false)
    assert.equal(loadCountingHistory(p, new Date(last.getTime() + 121 * MINUTE)).teamStop(during), true)
  })

  it('does not treat it as stalled when events.jsonl is absent', () => {
    assert.equal(loadTeamStop(setup(), NOW)(C1), false)
  })
})

describe('assessItem and checkpoints during which all sessions were stalled', () => {
  it('excludes those checkpoints from effort, shifts the checkpoint that reported the overrun later, and shows the number excluded', () => {
    const one = assessItem(doing(), historyOf([], stopAt(C1)), config, NOW)
    assert.equal(one.effort, 3)
    assert.equal(one.over, 1)
    assert.equal(one.overSince, C4.toISOString())
    assert.equal(one.teamStopped, 1)
    const two = assessItem(doing(), historyOf([], stopAt(C1, C2)), config, NOW)
    assert.deepEqual([two.effort, two.over, two.overSince, two.teamStopped], [2, 0, null, 2])
  })

  it('checkpoints that overlap with ones excluded for a blocked reason are not counted in the number excluded', () => {
    const blocked = doing({ reason: 'External wait', since: '2026-10-30' })
    const one = assessItem(blocked, historyOf([], stopAt(C1, C4)), config, NOW)
    assert.deepEqual([one.effort, one.teamStopped], [1, 1])
  })

  it('when no checkpoint was excluded, the item for the number excluded is absent', () => {
    assert.equal('teamStopped' in assessItem(doing(), historyOf([], stopAt(jst('2026-10-01T00:00:00'))), config, NOW), false)
    assert.equal('teamStopped' in assessItem(doing(), historyOf(), config, NOW), false)
  })
})

describe('text of S-POINTS-OVER', () => {
  const over = (stop?: (at: Date) => boolean) =>
    lintSprint(snapshot([doing()]), historyOf([], stop), config, NOW).filter((one) => one.rule === 'S-POINTS-OVER')

  it('when all sessions were stalled and checkpoints were excluded, shows "excluded checkpoints n"', () => {
    const [finding] = over(stopAt(C1))
    assert.match(finding?.message ?? '', /\(budget 2 checkpoints\) \(\+1\)\. Checkpoints with a block are excluded\. Checkpoints excluded because all sessions were stopped: 1$/)
  })

  it('when no checkpoint was excluded, writes nothing', () => {
    const [finding] = over()
    assert.doesNotMatch(finding?.message ?? '', /excluded because all sessions were stopped/)
  })
})

describe('all 5 paths that use stalled checkpoints read the gaps in events.jsonl', () => {
  it('checkpoint record (passed to buildRecord); keeps the effort at the time of recording and the checkpoints excluded', () => {
    const record = buildRecord(snapshot([doing()]), historyOf([], stopAt(C1)), config, C4, NOW)
    assert.deepEqual([record.items[0]?.effort, record.items[0]?.teamStopped], [3, 1])
  })

  it('checkpoint record (recordDueCheckpoint reads from events.jsonl)', () => {
    const p = setup()
    writeActivityWithGapAtC1(p)
    const record = recordDueCheckpoint(p, config, snapshot([doing()]), NOW, () => undefined)
    assert.deepEqual([record?.items[0]?.effort, record?.items[0]?.teamStopped], [3, 1])
  })

  it('the scrum points table (formatPoints)', () => {
    const text = formatPoints(snapshot([doing()]), historyOf([], stopAt(C1, C2)), config, NOW, [])
    assert.match(text, /\napp#1\t3\t2\t2 \(excluded checkpoints 2\)\t0\t/)
    assert.match(text, /Checkpoints with a block and checkpoints where all sessions were stopped are excluded/)
  })

  it('scrum points (pointsCommand reads from events.jsonl)', () => {
    const p = setup()
    appendLine(p.events, eventLine('member-state', jst('2026-10-29T10:00:00')))
    writeJson(p.snapshot, snapshot([doing()]))
    assert.match(pointsCommand(p, config), /\napp#1\t3\t2\t0 \(excluded checkpoints \d+\)\t0\t/)
  })

  it('the S-POINTS-OVER finding (loadContext and lintAll read from events.jsonl)', () => {
    const p = setup()
    writeActivityWithGapAtC1(p)
    const found = lintAll(loadContext(p, config, NOW, fakePorts().sessions, snapshot([doing()]))).active.filter((one) => one.rule === 'S-POINTS-OVER')
    assert.match(found[0]?.message ?? '', /Checkpoints excluded because all sessions were stopped: 1$/)
  })

  it('an acknowledgement (scrum ack S-POINTS-OVER) decides the checkpoint that reported the overrun with the same counting as the finding', () => {
    const p = setup()
    writeActivityWithGapAtC1(p)
    writeJson(p.snapshot, snapshot([doing()]))
    const mark = '<!-- scrum:points-overrun decision=keep from=3 to=3 -->\nTechLead: one line of reasoning'
    const ack = (createdAt: Date) =>
      ackCommand(p, ['S-POINTS-OVER', 'app#1'], { for: '1d', reason: 'decide in the review' }, config, NOW, { comments: () => [{ body: mark, createdAt: createdAt.toISOString() } satisfies IssueComment] })
    // With the stalled C1 excluded, the checkpoint that reported the overrun is C4 (13:00), not C3 (08:00). A marker between C3 and C4 cannot be used
    assert.match(ack(new Date(C3.getTime() + 60 * MINUTE)), new RegExp(`added after the checkpoint that showed the overrun \\(${C4.toISOString().replaceAll('.', '\\.')}\\)`))
    assert.match(ack(new Date(C4.getTime() + 30 * MINUTE)), /^Acknowledged: S-POINTS-OVER app#1/)
  })

  it('the record of finished issues (recordCompletions reads from events.jsonl)', () => {
    const p = setup()
    writeActivityWithGapAtC1(p)
    const previous = snapshot([doing()])
    const fresh = snapshot([issue(1, { status: config.statuses.done, points: 3 })])
    const timeline = [...doingSince, { at: jst('2026-10-30T13:50:00').toISOString(), status: config.statuses.done }]
    const [one] = recordCompletions(p, previous, fresh, config, NOW, () => new Map([['app#1', timeline]]))
    assert.equal(one?.effort, 3)
  })
})
