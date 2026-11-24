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
  it('空いて、渡せる issue が無い部下を、no-candidate で返す', () => {
    assert.deepEqual(choices().map((one) => [one.member.name, one.reason]), [['SWE1', 'no-candidate']])
  })

  it('次にやるに担当なしの issue があれば、渡せるので返さない。他の人の担当のものは渡せない', () => {
    assert.deepEqual(choices(snapshot([issue(1, { status: 'Next' })])), [])
    assert.equal(choices(snapshot([issue(1, { status: 'Next', assignee: 'SWE2' })])).length, 1)
  })

  it('バックログでも、その人の担当なら渡せるので返さない', () => {
    assert.deepEqual(choices(snapshot([issue(1, { status: 'Backlog', assignee: 'SWE1' })])), [])
  })

  it('作業中が上限に達していれば wip-limit で返す', () => {
    const busyBoard = snapshot([issue(1, { status: 'In Progress', assignee: 'SWE2' }), issue(2, { status: 'Next' })])
    const tight = { ...enabled, wipLimit: 1 }
    assert.deepEqual(choices(busyBoard, [idle('SWE1')], [], [], tight).map((one) => one.reason), ['wip-limit'])
  })

  it('止まっていない自分の作業中があれば、渡せないのではなく促す場合なので返さない', () => {
    assert.deepEqual(choices(snapshot([issue(1, { status: 'In Progress', assignee: 'SWE1' })])), [])
  })

  it('自分の作業中が止まっていれば、渡せるものが無い扱いになる', () => {
    const stuck = snapshot([issue(1, { status: 'In Progress', assignee: 'SWE1', reason: 'Needs decision' })])
    assert.equal(choices(stuck).length, 1)
  })

  it('空きが idleMinutes に満たないか、受け入れがあるか、渡す相手でなければ返さない', () => {
    const ack: Ack = { rule: 'T-IDLE', subject: 'SWE1', until: minutesLater(30).toISOString(), reason: "Waiting for the owner's answer", at: minutesAgo(5) }
    assert.deepEqual(choices(none, [idle('SWE1', 9)]), [])
    assert.deepEqual(choices(none, [idle('SWE1')], [ack]), [])
    assert.deepEqual(choices(none, [idle('SWE1')], [], [], { ...enabled, dispatch: { ...enabled.dispatch!, members: ['SWE2'] } }), [])
  })

  it('渡した後に動いていない人 (渡し済み) は、渡せるものが無いのではないので返さない', () => {
    const record: DispatchRecord = { at: minutesAgo(5), member: 'SWE1', label: 'app#9', title: 'x' }
    assert.deepEqual(choices(none, [idle('SWE1')], [], [record]), [])
  })

  it('dispatch が有効でなければ、返さない', () => {
    assert.deepEqual(choices(none, [idle('SWE1')], [], [], { ...enabled, dispatch: undefined }), [])
  })
})

describe('advanceEmpty', () => {
  const now = choices()

  it('初めて見たときはいまの時刻、続けて見たときは前の時刻。直れば消える', () => {
    assert.deepEqual(advanceEmpty({}, now, NOW), { 'SWE1:no-candidate': NOW.toISOString() })
    assert.deepEqual(advanceEmpty({ 'SWE1:no-candidate': minutesAgo(20) }, now, NOW), { 'SWE1:no-candidate': minutesAgo(20) })
    assert.deepEqual(advanceEmpty({ 'SWE1:no-candidate': minutesAgo(20) }, [], NOW), {})
  })

  it('理由が変われば、その時から数え直す (作業中が上限で空いていた人が、渡せる issue が無いに変わっても、前の時刻を持ち越さない)', () => {
    const limited = advanceEmpty({}, choices(snapshot([issue(1, { status: 'In Progress', assignee: 'SWE2' })]), [idle('SWE1')], [], [], { ...enabled, wipLimit: 1 }), new Date(minutesAgo(120)))
    assert.deepEqual(Object.keys(limited), ['SWE1:wip-limit'])
    const changed = advanceEmpty(limited, now, NOW)
    assert.deepEqual(changed, { 'SWE1:no-candidate': NOW.toISOString() })
  })

  it('理由が変わった直後は、30 分たつまで Q-EMPTY-OWNER も、オーナーへの通知も出さない', () => {
    const since = { 'SWE1:wip-limit': minutesAgo(120), 'SWE1:no-candidate': minutesAgo(1) }
    const result = evaluateEmpty(now, since, enabled, NOW)
    assert.deepEqual(result.findings.map((finding) => finding.rule), ['Q-EMPTY'])
    assert.equal(result.owner.length, 0)
  })
})

describe('evaluateEmpty', () => {
  it('見つけた時から Q-EMPTY (重さ高) を出し、30 分に満たないうちは、オーナーへの通知を作らない', () => {
    const result = evaluateEmpty(choices(), { 'SWE1:no-candidate': minutesAgo(29) }, enabled, NOW)
    assert.deepEqual(result.findings.map((one) => [one.rule, one.severity, one.subject, one.minutes]), [['Q-EMPTY', 'high', 'SWE1', 29]])
    assert.deepEqual(result.owner, [])
    assert.match(result.findings[0]?.message ?? '', /^SWE1 is idle but there is no issue to hand over \(no issue to hand over in Next \(unassigned or SWE1\) or in Backlog \(assigned to SWE1\)\)\. It has lasted 29 minutes$/)
  })

  it('30 分で Q-EMPTY-OWNER を足し、オーナーへの通知と macOS の通知を作る', () => {
    const result = evaluateEmpty(choices(), { 'SWE1:no-candidate': minutesAgo(30) }, enabled, NOW)
    assert.deepEqual(result.findings.map((one) => one.rule), ['Q-EMPTY', 'Q-EMPTY-OWNER'])
    const notice = result.owner[0]
    assert.equal(notice?.key, result.findings[1]?.key)
    assert.match(notice?.text ?? '', /send the owner one PushNotification \(no sound; do not change the text\)/)
    assert.match(notice?.desktop?.body ?? '', /^30 minutes have passed with no issue to hand over to SWE1/)
    assert.doesNotMatch(notice?.text ?? '', /one line with the pending question/)
  })

  it('上限は設定の emptyEscalateMinutes に従う', () => {
    const short = { ...enabled, alerts: { ...enabled.alerts!, emptyEscalateMinutes: 10 } }
    assert.equal(evaluateEmpty(choices(), { 'SWE1:no-candidate': minutesAgo(10) }, short, NOW).owner.length, 1)
  })

  it('wip-limit の理由は、作業中の上限の件数で書く', () => {
    const tight = { ...enabled, wipLimit: 1 }
    const board = snapshot([issue(1, { status: 'In Progress', assignee: 'SWE2' })])
    const result = evaluateEmpty(choices(board, [idle('SWE1')], [], [], tight), { 'SWE1:wip-limit': minutesAgo(1) }, tight, NOW)
    assert.match(result.findings[0]?.message ?? '', /In Progress is at the limit of 1/)
  })

  it('最初に見た時刻がまだ無ければ出さない', () => {
    assert.deepEqual(evaluateEmpty(choices(), {}, enabled, NOW), { findings: [], owner: [] })
  })
})

describe('Q-EMPTY の、作業中が上限のとき', () => {
  const tight = { ...enabled, wipLimit: 1 }
  const busyBoard = snapshot([issue(1, { status: 'In Progress', assignee: 'SWE2' })])
  const limited = () => evaluateEmpty(choices(busyBoard, [idle('SWE1')], [], [], tight), { 'SWE1:wip-limit': minutesAgo(45) }, tight, NOW)

  it('TechLead には Q-EMPTY を出すが、渡すものが尽きたのではないので、Q-EMPTY-OWNER も、オーナーへの通知も出さない (30 分を過ぎても)', () => {
    const result = limited()
    assert.deepEqual(result.findings.map((finding) => finding.rule), ['Q-EMPTY'])
    assert.deepEqual(result.owner, [])
    assert.match(result.findings[0]?.fix ?? '', /Nothing can be handed over because In Progress is at the limit\. Review the blocked In Progress items/)
  })

  it('候補が無いときは、30 分で Q-EMPTY-OWNER と通知を出し、通知は同じ人について emptyPushMinutes (既定 60 分) に 1 回までの印を持つ', () => {
    const result = evaluateEmpty(choices(), { 'SWE1:no-candidate': minutesAgo(45) }, enabled, NOW)
    assert.deepEqual(result.findings.map((finding) => finding.rule).toSorted(), ['Q-EMPTY', 'Q-EMPTY-OWNER'])
    assert.deepEqual(result.owner[0]?.throttle?.key, 'empty:SWE1')
    assert.equal(result.owner[0]?.throttle?.minutes, 60)
    assert.equal(result.owner[0]?.owner?.line, 'no issue to hand over to SWE1 for 45 minutes (no issue to hand over in Next (unassigned or SWE1) or in Backlog (assigned to SWE1))')
  })

  it('同じ人の間隔は、設定の emptyPushMinutes に従う', () => {
    const short = { ...enabled, alerts: { ...enabled.alerts!, emptyPushMinutes: 15 } }
    assert.equal(evaluateEmpty(choices(), { 'SWE1:no-candidate': minutesAgo(45) }, short, NOW).owner[0]?.throttle?.minutes, 15)
  })
})
