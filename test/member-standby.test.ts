import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lintAll } from '../src/findings/lint.ts'
import type { Config } from '../src/config.ts'
import { formatReport, memberReport } from '../src/members/list.ts'
import { isLeadCaller, lintStandbyBusy, parseUntil, pruneStandby, readStandby, standbyCommand, viewStandby, type Standby } from '../src/members/standby.ts'
import { paths, type Paths } from '../src/store.ts'
import type { SessionSignal } from '../src/team/types.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const member = (name: string, state: 'idle' | 'busy', sinceMinutes: number) => ({ name, state, since: minutesAgo(sinceMinutes), sessions: 1 }) as never
const mark = (name: string, extra: Partial<Standby> = {}): Standby => ({ name, reason: 'ready work ran out', since: minutesAgo(30), by: 'TechLead', ...extra })

describe('a member on standby', () => {
  const idle = [member('SWE1', 'idle', 60), member('SWE2', 'idle', 60)]
  const run = (standby: readonly Standby[], board = snapshot([]), members = idle) => lintAll({ snapshot: board, members, acks: [], config, now: NOW, standby })

  it('raises no T-IDLE, while a member that is not on standby still does', () => {
    const rules = run([mark('SWE1')]).active.filter((one) => one.rule === 'T-IDLE').map((one) => one.subject)
    assert.deepEqual(rules, ['SWE2'])
    assert.deepEqual(run([]).active.filter((one) => one.rule === 'T-IDLE').map((one) => one.subject).toSorted(), ['SWE1', 'SWE2'])
  })

  it('ends when the member gets an item: one In Progress or in Next with the member as assignee', () => {
    const doing = snapshot([issue(1, { status: 'In Progress', assignee: 'SWE1' })])
    const next = snapshot([issue(2, { status: 'Next', assignee: 'SWE1' })])
    for (const board of [doing, next]) {
      assert.equal(run([mark('SWE1')], board).active.some((one) => one.rule === 'T-IDLE' && one.subject === 'SWE1'), true)
      assert.deepEqual(viewStandby([mark('SWE1')], board, config, NOW).ended.map((one) => one.why), ['item'])
    }
    // an issue of someone else, or a Backlog one, does not end it
    const other = snapshot([issue(3, { status: 'In Progress', assignee: 'SWE2' }), issue(4, { status: 'Backlog', assignee: 'SWE1' })])
    assert.equal(viewStandby([mark('SWE1')], other, config, NOW).active.length, 1)
  })

  it('ends at --until, and not before', () => {
    const until = new Date(NOW.getTime() + 60_000).toISOString()
    assert.equal(viewStandby([mark('SWE1', { until })], null, config, NOW).active.length, 1)
    assert.deepEqual(viewStandby([mark('SWE1', { until })], null, config, new Date(NOW.getTime() + 60_000)).ended.map((one) => one.why), ['until'])
    assert.equal(run([mark('SWE1', { until: minutesAgo(1) })]).active.some((one) => one.rule === 'T-IDLE' && one.subject === 'SWE1'), true)
  })

  it('does not come back after it ended by an item: a refresh drops the mark', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-standby-')))
    standbyCommand(p.memberStandby, config, { name: 'SWE1', off: false, reason: 'idle', until: undefined, caller: '' }, NOW)
    pruneStandby(p.memberStandby, snapshot([issue(1, { status: 'In Progress', assignee: 'SWE1' })]), config, NOW)
    assert.deepEqual(readStandby(p.memberStandby), [])
    assert.equal(run(readStandby(p.memberStandby)).active.filter((one) => one.rule === 'T-IDLE').length, 2)
  })

  it('is told as a finding when it has been busy for a long time with no item (the mark is stale), and not as T-BUSY-UNTRACKED', () => {
    const busy = [member('SWE1', 'busy', config.untrackedMinutes + 5), member('SWE2', 'busy', config.untrackedMinutes + 5)]
    const result = run([mark('SWE1')], snapshot([]), busy).active
    const stale = result.find((one) => one.rule === 'T-STANDBY-BUSY')
    assert.deepEqual([stale?.subject, stale?.severity], ['SWE1', 'medium'])
    assert.match(stale?.message ?? '', /^SWE1 is on standby \(ready work ran out\) but has been busy for \d+ minutes with no item on the board, so the mark is stale/)
    assert.deepEqual(result.filter((one) => one.rule === 'T-BUSY-UNTRACKED').map((one) => one.subject), ['SWE2'])
    assert.deepEqual(lintStandbyBusy([mark('SWE1')], [member('SWE1', 'busy', 1)], config, NOW), [])
  })
})

describe('scrum member standby', () => {
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-standby-cmd-')))
  })
  const set = (caller: string, extra: object = {}, name = 'SWE1') => standbyCommand(p.memberStandby, config, { name, off: false, reason: 'ready work ran out', until: undefined, caller, ...extra }, NOW)

  it('is for the lead only: its session, or a person at a terminal; a member\'s session is refused', () => {
    assert.match(set('SWE2'), /^only the lead \(TechLead\) puts a member on standby; this session is SWE2/)
    assert.deepEqual(readStandby(p.memberStandby), [])
    assert.match(set('TechLead'), /^SWE1: on standby/)
    assert.match(set(''), /^SWE1: on standby/)
    assert.deepEqual([isLeadCaller('TechLead (2)', config), isLeadCaller('SWE1', config)], [true, false])
  })

  it('keeps the reason, since when, and by whom, and shows them in `scrum member list`', () => {
    set('TechLead', { reason: 'ready work ran out' })
    const [one] = readStandby(p.memberStandby)
    assert.deepEqual([one?.name, one?.reason, one?.since, one?.by], ['SWE1', 'ready work ran out', NOW.toISOString(), 'TechLead'])
    const signals: SessionSignal[] = [{ sessionId: 's1', name: 'SWE1', state: 'idle', since: minutesAgo(5), updatedAt: minutesAgo(5), isAlive: true, nameSince: null }]
    const text = formatReport(memberReport(config, null, signals), [], new Map(), new Map(), readStandby(p.memberStandby))
    assert.match(text, /SWE1 .*\[standby since 2026-10-08T06:00Z: ready work ran out\]/)
    assert.doesNotMatch(text, /SWE2 .*standby/)
  })

  it('needs a reason, and a member of the team, and a deadline in the future', () => {
    assert.match(set('TechLead', { reason: '  ' }), /--reason is needed/)
    assert.match(set('TechLead', {}, 'Stranger'), /Stranger is not a member of this team/)
    assert.match(set('TechLead', { until: '2020-01-01T00:00:00Z' }), /--until must be a time in the future/)
    assert.match(set('TechLead', { until: 'soon' }), /--until must be a time in the future/)
    assert.deepEqual(readStandby(p.memberStandby), [])
  })

  it('takes --until as a clock time in the team\'s zone, a length, or a time, and says when it ends', () => {
    const zone: Config = { ...config, runtime: { label: 'app', utcOffset: '+09:00' } }
    assert.equal(parseUntil('4h', NOW, zone)?.toISOString(), '2026-10-08T10:00:00.000Z')
    assert.equal(parseUntil('90m', NOW, zone)?.toISOString(), '2026-10-08T07:30:00.000Z')
    // 06:00Z is 15:00 at +09:00: 17:30 is today, 09:00 is tomorrow
    assert.equal(parseUntil('17:30', NOW, zone)?.toISOString(), '2026-10-08T08:30:00.000Z')
    assert.equal(parseUntil('09:00', NOW, zone)?.toISOString(), '2026-10-09T00:00:00.000Z')
    assert.equal(parseUntil('2026-12-01T09:00:00Z', NOW, zone)?.toISOString(), '2026-12-01T09:00:00.000Z')
    assert.match(set('TechLead', { until: '4h' }), /until 2026-10-08T10:00:00\.000Z/)
  })

  it('is ended with --off, and says so when it was not on standby; a second mark replaces the first', () => {
    set('TechLead')
    set('TechLead', { reason: 'second' })
    assert.deepEqual(readStandby(p.memberStandby).map((one) => one.reason), ['second'])
    assert.equal(standbyCommand(p.memberStandby, config, { name: 'SWE1', off: true, reason: undefined, until: undefined, caller: 'TechLead' }, NOW), 'SWE1: standby ended')
    assert.equal(standbyCommand(p.memberStandby, config, { name: 'SWE1', off: true, reason: undefined, until: undefined, caller: 'TechLead' }, NOW), 'SWE1 is not on standby')
    assert.match(standbyCommand(p.memberStandby, config, { name: 'SWE1', off: true, reason: undefined, until: undefined, caller: 'SWE2' }, NOW), /^only the lead/)
  })
})
