import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { advanceEmpty, emptyChoices } from '../src/alerts/empty.ts'
import { evaluateEmpty } from '../src/alerts/empty-findings.ts'
import type { DispatchRecord } from '../src/dispatch/types.ts'
import type { Ack } from '../src/findings/acks.ts'
import { issue, NOW, snapshot } from './helpers.ts'
import { enabled, idle, minutesAgo, minutesLater } from './alerts-fixtures.ts'

const none = snapshot([issue(1, { status: 'Backlog' })])
const choices = (items = none, members = [idle('SWE1')], acks: readonly Ack[] = [], records: readonly DispatchRecord[] = [], config = enabled) =>
  emptyChoices(items, members, acks, records, config, NOW)

describe('emptyChoices', () => {
  it('reports an idle member with no issue to hand over as no-candidate', () => {
    assert.deepEqual(choices().map((one) => [one.member.name, one.reason]), [['SWE1', 'no-candidate']])
  })

  it('does not report when Next holds an unassigned issue, since it can be handed over; issues assigned to someone else cannot be handed over', () => {
    assert.deepEqual(choices(snapshot([issue(1, { status: 'Next' })])), [])
    assert.equal(choices(snapshot([issue(1, { status: 'Next', assignee: 'SWE2' })])).length, 1)
  })

  it('does not report when the Backlog holds an issue assigned to that person, since it can be handed over', () => {
    assert.deepEqual(choices(snapshot([issue(1, { status: 'Backlog', assignee: 'SWE1' })])), [])
  })

  it('reports wip-limit when In Progress has reached the limit', () => {
    const busyBoard = snapshot([issue(1, { status: 'In Progress', assignee: 'SWE2' }), issue(2, { status: 'Next' })])
    const tight = { ...enabled, wipLimit: 1 }
    assert.deepEqual(choices(busyBoard, [idle('SWE1')], [], [], tight).map((one) => one.reason), ['wip-limit'])
  })

  it('does not report when the member has their own In Progress work that is not stalled, since that is a case for a nudge, not for handing over', () => {
    assert.deepEqual(choices(snapshot([issue(1, { status: 'In Progress', assignee: 'SWE1' })])), [])
  })

  it('treats the member as having nothing to hand over when their own In Progress work is stalled', () => {
    const stuck = snapshot([issue(1, { status: 'In Progress', assignee: 'SWE1', reason: 'Needs decision' })])
    assert.equal(choices(stuck).length, 1)
  })

  it('does not report when the idle time is under idleMinutes, an acknowledgement exists, or the member is not a hand-over target', () => {
    const ack: Ack = { rule: 'T-IDLE', subject: 'SWE1', until: minutesLater(30).toISOString(), reason: "Waiting for the owner's answer", at: minutesAgo(5) }
    assert.deepEqual(choices(none, [idle('SWE1', 9)]), [])
    assert.deepEqual(choices(none, [idle('SWE1')], [ack]), [])
    assert.deepEqual(choices(none, [idle('SWE1')], [], [], { ...enabled, dispatch: { ...enabled.dispatch!, members: ['SWE2'] } }), [])
  })

  it('does not report a member who is not moving after a hand-over (already handed over), since it is not a case of nothing to hand over', () => {
    const record: DispatchRecord = { at: minutesAgo(5), member: 'SWE1', label: 'app#9', title: 'x' }
    assert.deepEqual(choices(none, [idle('SWE1')], [], [record]), [])
  })

  it('does not report when dispatch is not enabled', () => {
    assert.deepEqual(choices(none, [idle('SWE1')], [], [], { ...enabled, dispatch: undefined }), [])
  })
})

describe('advanceEmpty', () => {
  const now = choices()

  it('takes the current time when first seen and the earlier time when seen again; it disappears once fixed', () => {
    assert.deepEqual(advanceEmpty({}, now, NOW), { 'SWE1:no-candidate': NOW.toISOString() })
    assert.deepEqual(advanceEmpty({ 'SWE1:no-candidate': minutesAgo(20) }, now, NOW), { 'SWE1:no-candidate': minutesAgo(20) })
    assert.deepEqual(advanceEmpty({ 'SWE1:no-candidate': minutesAgo(20) }, [], NOW), {})
  })

  it('counts again from that moment when the reason changes (a member idle at the In Progress limit who then has no issue to hand over does not carry over the earlier time)', () => {
    const limited = advanceEmpty({}, choices(snapshot([issue(1, { status: 'In Progress', assignee: 'SWE2' })]), [idle('SWE1')], [], [], { ...enabled, wipLimit: 1 }), new Date(minutesAgo(120)))
    assert.deepEqual(Object.keys(limited), ['SWE1:wip-limit'])
    const changed = advanceEmpty(limited, now, NOW)
    assert.deepEqual(changed, { 'SWE1:no-candidate': NOW.toISOString() })
  })

  it('right after the reason changes, emits neither Q-EMPTY-OWNER nor an owner notification until 30 minutes pass', () => {
    const since = { 'SWE1:wip-limit': minutesAgo(120), 'SWE1:no-candidate': minutesAgo(1) }
    const result = evaluateEmpty(now, since, enabled, NOW)
    assert.deepEqual(result.findings.map((finding) => finding.rule), ['Q-EMPTY'])
    assert.equal(result.owner.length, 0)
  })
})

describe('evaluateEmpty', () => {
  it('emits Q-EMPTY (high severity) from the moment it is found, and creates no owner notification before 30 minutes', () => {
    const result = evaluateEmpty(choices(), { 'SWE1:no-candidate': minutesAgo(29) }, enabled, NOW)
    assert.deepEqual(result.findings.map((one) => [one.rule, one.severity, one.subject, one.minutes]), [['Q-EMPTY', 'high', 'SWE1', 29]])
    assert.deepEqual(result.owner, [])
    assert.match(result.findings[0]?.message ?? '', /^SWE1 is idle but there is no issue to hand over \(no issue to hand over in Next \(unassigned or SWE1\) or in Backlog \(assigned to SWE1\)\)\. It has lasted 29 minutes$/)
  })

  it('adds Q-EMPTY-OWNER at 30 minutes and creates the owner notification and the desktop notification', () => {
    const result = evaluateEmpty(choices(), { 'SWE1:no-candidate': minutesAgo(30) }, enabled, NOW)
    assert.deepEqual(result.findings.map((one) => one.rule), ['Q-EMPTY', 'Q-EMPTY-OWNER'])
    const notice = result.owner[0]
    assert.equal(notice?.key, result.findings[1]?.key)
    assert.match(notice?.text ?? '', /send the owner one PushNotification \(no sound; do not change the text\)/)
    assert.match(notice?.desktop?.body ?? '', /^30 minutes have passed with no issue to hand over to SWE1/)
    assert.doesNotMatch(notice?.text ?? '', /one line with the pending question/)
  })

  it('follows emptyEscalateMinutes of the config for the limit', () => {
    const short = { ...enabled, alerts: { ...enabled.alerts!, emptyEscalateMinutes: 10 } }
    assert.equal(evaluateEmpty(choices(), { 'SWE1:no-candidate': minutesAgo(10) }, short, NOW).owner.length, 1)
  })

  it('writes the wip-limit reason with the In Progress limit count', () => {
    const tight = { ...enabled, wipLimit: 1 }
    const board = snapshot([issue(1, { status: 'In Progress', assignee: 'SWE2' })])
    const result = evaluateEmpty(choices(board, [idle('SWE1')], [], [], tight), { 'SWE1:wip-limit': minutesAgo(1) }, tight, NOW)
    assert.match(result.findings[0]?.message ?? '', /In Progress is at the limit of 1/)
  })

  it('does not report when the first-seen time does not exist yet', () => {
    assert.deepEqual(evaluateEmpty(choices(), {}, enabled, NOW), { findings: [], owner: [] })
  })
})

describe('Q-EMPTY when In Progress is at the limit', () => {
  const tight = { ...enabled, wipLimit: 1 }
  const busyBoard = snapshot([issue(1, { status: 'In Progress', assignee: 'SWE2' })])
  const limited = () => evaluateEmpty(choices(busyBoard, [idle('SWE1')], [], [], tight), { 'SWE1:wip-limit': minutesAgo(45) }, tight, NOW)

  it('emits Q-EMPTY for the TechLead but, since the supply of issues to hand over has not run out, emits neither Q-EMPTY-OWNER nor an owner notification (even past 30 minutes)', () => {
    const result = limited()
    assert.deepEqual(result.findings.map((finding) => finding.rule), ['Q-EMPTY'])
    assert.deepEqual(result.owner, [])
    assert.match(result.findings[0]?.fix ?? '', /Nothing can be handed over because In Progress is at the limit\. Review the blocked In Progress items/)
  })

  it('with no candidate, emits Q-EMPTY-OWNER and a notification at 30 minutes, and the notification carries a marker limiting it to once per emptyPushMinutes (default 60 minutes) for the same person', () => {
    const result = evaluateEmpty(choices(), { 'SWE1:no-candidate': minutesAgo(45) }, enabled, NOW)
    assert.deepEqual(result.findings.map((finding) => finding.rule).toSorted(), ['Q-EMPTY', 'Q-EMPTY-OWNER'])
    assert.deepEqual(result.owner[0]?.throttle?.key, 'empty:SWE1')
    assert.equal(result.owner[0]?.throttle?.minutes, 60)
    assert.equal(result.owner[0]?.owner?.line, 'no issue to hand over to SWE1 for 45 minutes (no issue to hand over in Next (unassigned or SWE1) or in Backlog (assigned to SWE1))')
  })

  it('the interval for the same person follows emptyPushMinutes of the config', () => {
    const short = { ...enabled, alerts: { ...enabled.alerts!, emptyPushMinutes: 15 } }
    assert.equal(evaluateEmpty(choices(), { 'SWE1:no-candidate': minutesAgo(45) }, short, NOW).owner[0]?.throttle?.minutes, 15)
  })
})
