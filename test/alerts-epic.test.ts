import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { advanceEpics, epicViews } from '../src/alerts/epic.ts'
import { evaluateEpicStalls } from '../src/alerts/epic-findings.ts'
import type { MemberState } from '../src/team/types.ts'
import { config, NOW, snapshot } from './helpers.ts'
import { busy, child, enabled, epic, idle, minutesAgo } from './alerts-fixtures.ts'

const doing = (number: number, assignee: string | null, reason = 'None') => child(number, { status: 'In Progress', assignee, reason })

describe('epicViews', () => {
  it('a person who has an In Progress child and is moving becomes the person moving it', () => {
    const views = epicViews(snapshot([epic(), doing(101, 'SWE1'), child(102, { status: 'Next' })]), [busy('SWE1'), idle('SWE2')], enabled)
    assert.deepEqual(views.map((view) => [view.epic, view.movers, view.openChildren.length]), [['app#100', ['SWE1'], 2]])
  })

  it('a person waiting for permission (waiting) does not count as moving; only a person who is working (busy) counts', () => {
    const items = [epic(), doing(101, 'SWE1')]
    const waiting: MemberState = { name: 'SWE1', state: 'waiting', since: minutesAgo(5) }
    assert.deepEqual(epicViews(snapshot(items), [waiting], enabled).map((view) => view.movers), [[]])
    assert.deepEqual(epicViews(snapshot(items), [busy('SWE1')], enabled).map((view) => view.movers), [['SWE1']])
  })

  it('if the assignee of an In Progress child is idle (not moving) or there is no assignee, nobody is moving', () => {
    const members = [idle('SWE1'), busy('SWE2')]
    assert.deepEqual(epicViews(snapshot([epic(), doing(101, 'SWE1')]), members, enabled).map((view) => view.movers), [[]])
    assert.deepEqual(epicViews(snapshot([epic(), doing(101, null)]), members, enabled).map((view) => view.movers), [[]])
  })

  it('a moving person who has an In Progress child of another Epic does not count as moving this Epic', () => {
    const other = child(201, { epic: 'app#200', status: 'In Progress', assignee: 'SWE2' })
    const views = epicViews(snapshot([epic(), child(101, { status: 'Next' }), other]), [busy('SWE2')], enabled)
    assert.deepEqual(views.map((view) => [view.epic, view.movers]), [['app#100', []], ['app#200', ['SWE2']]])
  })

  it('an Epic whose children are all in the Backlog is also included as an Epic that needs someone to move it (with 0 people moving)', () => {
    const views = epicViews(snapshot([epic(), child(101, { status: 'Backlog' }), child(102, { status: 'Backlog' })]), [busy('SWE1')], enabled)
    assert.deepEqual(views.map((view) => [view.epic, view.movers, view.openChildren.length]), [['app#100', [], 2]])
  })

  it('an Epic whose children are only in Release or Done (the work is finished) is not included; one child in the Backlog is enough to include it', () => {
    const done = [epic(), child(101, { status: 'Release' }), child(102, { status: 'Done' })]
    assert.deepEqual(epicViews(snapshot(done), [], enabled), [])
    assert.equal(epicViews(snapshot([...done, child(103, { status: 'Backlog' })]), [], enabled).length, 1)
  })

  it('is not included when the Epic itself carries the parked-marker label (alerts.parkedLabels)', () => {
    const items = [child(101, { status: 'Backlog' })]
    assert.deepEqual(epicViews(snapshot([epic({ labels: ['epic:parked'] }), ...items]), [], enabled), [])
    assert.equal(epicViews(snapshot([epic({ labels: ['bug'] }), ...items]), [], enabled).length, 1)
    const custom = { ...enabled, alerts: { ...enabled.alerts!, parkedLabels: ['parked'] } }
    assert.deepEqual(epicViews(snapshot([epic({ labels: ['parked'] }), ...items]), [], custom), [])
    assert.equal(epicViews(snapshot([epic({ labels: ['epic:parked'] }), ...items]), [], custom).length, 1)
  })

  it("does not look at the labels of children (the parked marker is only the Epic's own label); an Epic missing from the board is included because the marker cannot be read", () => {
    assert.equal(epicViews(snapshot([epic(), child(101, { status: 'Backlog', labels: ['epic:parked'] })]), [], enabled).length, 1)
    assert.equal(epicViews(snapshot([child(101, { status: 'Backlog' })]), [], enabled).length, 1)
  })

  it('an Epic with only Next children is expected to start moving and has nobody moving it', () => {
    const views = epicViews(snapshot([epic(), child(101, { status: 'Next' })]), [idle('SWE1')], enabled)
    assert.deepEqual(views.map((view) => [view.epic, view.movers, view.doing.length]), [['app#100', [], 0]])
  })

  it('is not included when the Epic itself is closed on the board; is included when missing from the board (it has no title)', () => {
    const open = [child(101, { status: 'Next' })]
    assert.deepEqual(epicViews(snapshot([epic({ state: 'CLOSED' }), ...open]), [], enabled), [])
    assert.deepEqual(epicViews(snapshot(open), [], enabled).map((view) => [view.epic, view.title]), [['app#100', null]])
  })

  it('is not included when the author of the Epic itself is in excludeAuthors (another development agent), whoever authored the children', () => {
    const items = [epic({ author: 'external-dev' }), child(101, { status: 'Backlog' })]
    assert.deepEqual(epicViews(snapshot(items), [], enabled), [])
    assert.equal(epicViews(snapshot([epic({ author: 'owner' }), child(101, { status: 'Backlog' })]), [], enabled).length, 1)
  })

  it('closed children, PRs, and issues by excluded authors do not count as children', () => {
    const items = [
      epic(),
      child(101, { status: 'Next', state: 'CLOSED' }),
      child(102, { status: 'Next', kind: 'pr' }),
      child(103, { status: 'Next', author: 'external-dev' }),
    ]
    assert.deepEqual(epicViews(snapshot(items), [], enabled), [])
  })

  it('when only issues that have taken no parent (no epic field) exist, there is no Epic', () => {
    assert.deepEqual(epicViews(snapshot([epic({ status: 'In Progress', assignee: 'SWE1' })]), [busy('SWE1')], enabled), [])
  })
})

describe('advanceEpics', () => {
  const stalled = epicViews(snapshot([epic(), child(101, { status: 'Next' })]), [idle('SWE1')], enabled)
  const moving = epicViews(snapshot([epic(), doing(101, 'SWE1')]), [busy('SWE1')], enabled)

  it('an Epic seen for the first time with nobody moving it takes the current time as its first-seen time', () => {
    assert.deepEqual(advanceEpics({}, stalled, NOW), { 'app#100': NOW.toISOString() })
  })

  it('when seen again, it carries over the earlier time', () => {
    const first = minutesAgo(45)
    assert.deepEqual(advanceEpics({ 'app#100': first }, stalled, NOW), { 'app#100': first })
  })

  it('an Epic that starts moving disappears, and if it stops again, counting restarts from the new time', () => {
    const first = minutesAgo(45)
    assert.deepEqual(advanceEpics({ 'app#100': first }, moving, NOW), {})
    assert.deepEqual(advanceEpics({}, stalled, NOW), { 'app#100': NOW.toISOString() })
  })
})

describe('evaluateEpicStalls', () => {
  const views = (items = [epic(), child(101, { status: 'Next' })]) => epicViews(snapshot(items), [idle('SWE1')], enabled)

  it('emits nothing when 1 minute short of 60 minutes, and emits E-STALL (high severity) at 60 minutes', () => {
    assert.deepEqual(evaluateEpicStalls(views(), { 'app#100': minutesAgo(59) }, enabled, NOW).findings, [])
    const stalled = evaluateEpicStalls(views(), { 'app#100': minutesAgo(60) }, enabled, NOW)
    const [finding, ...rest] = stalled.findings
    assert.doesNotMatch(stalled.owner[0]?.text ?? '', /pending question/)
    assert.equal(rest.length, 0)
    assert.deepEqual([finding?.rule, finding?.severity, finding?.subject, finding?.minutes], ['E-STALL', 'high', 'app#100', 60])
    assert.match(finding?.message ?? '', /^Nobody has been moving Epic app#100 "Epic 100" for 60 minutes \(open children: 1\. no children In Progress\)$/)
    assert.equal(finding?.key, `E-STALL:app#100:${minutesAgo(60)}`)
  })

  it('does not emit for an Epic whose first-seen time does not exist yet', () => {
    assert.deepEqual(evaluateEpicStalls(views(), {}, enabled, NOW), { findings: [], owner: [] })
  })

  it('the minute limit follows epicStallMinutes of the config', () => {
    const short = { ...enabled, alerts: { ...enabled.alerts!, epicStallMinutes: 20 } }
    assert.equal(evaluateEpicStalls(views(), { 'app#100': minutesAgo(20) }, short, NOW).findings.length, 1)
  })

  it('when all In Progress children are waiting for an owner decision, lists the waiting children in the notification and has a question attached', () => {
    const waiting = views([epic(), doing(101, 'SWE1', 'Needs decision'), doing(102, 'SWE1', 'Needs decision')])
    const result = evaluateEpicStalls(waiting, { 'app#100': minutesAgo(61) }, enabled, NOW)
    const notice = result.owner[0]
    assert.match(notice?.text ?? '', /Waiting on: app#101, app#102\./)
    assert.match(notice?.text ?? '', /Add one line with the pending question \(subjects: app#101, app#102\)/)
    assert.match(notice?.desktop?.body ?? '', /Waiting on: app#101, app#102\./)
    assert.match(result.findings[0]?.fix ?? '', /Blocked only on the owner's answer/)
    assert.match(result.findings[0]?.message ?? '', /children In Progress: app#101 assignee SWE1 reason Needs decision, app#102 assignee SWE1 reason Needs decision/)
  })

  it('when even one In Progress child is waiting for something other than a decision, does not have a question attached', () => {
    const mixed = views([epic(), doing(101, 'SWE1', 'Needs decision'), doing(102, 'SWE1', 'None')])
    const result = evaluateEpicStalls(mixed, { 'app#100': minutesAgo(61) }, enabled, NOW)
    assert.doesNotMatch(result.owner[0]?.text ?? '', /pending question/)
    assert.doesNotMatch(result.owner[0]?.desktop?.body ?? '', /Waiting on/)
    assert.match(result.findings[0]?.fix ?? '', /Get the assignee moving/)
  })

  it('the notification key equals the finding key and carries a desktop notification; the title is cut at 40 characters', () => {
    const long = views([epic({ title: 'x'.repeat(50) }), child(101, { status: 'Next' })])
    const result = evaluateEpicStalls(long, { 'app#100': minutesAgo(61) }, enabled, NOW)
    assert.equal(result.owner[0]?.key, result.findings[0]?.key)
    assert.equal(result.owner[0]?.kind, 'owner')
    assert.match(result.owner[0]?.desktop?.body ?? '', new RegExp(`"${'x'.repeat(40)}…"`))
  })

  it('when the Epic is missing from the board and its title is unknown, emits without a title', () => {
    const noTitle = views([child(101, { status: 'Next' })])
    const finding = evaluateEpicStalls(noTitle, { 'app#100': minutesAgo(60) }, enabled, NOW).findings[0]
    assert.match(finding?.message ?? '', /^Nobody has been moving Epic app#100 for/)
  })

  it('even with a config that has no alerts setting, the limit defaults to 60 minutes', () => {
    const plain = { ...config, alerts: undefined }
    assert.equal(evaluateEpicStalls(views(), { 'app#100': minutesAgo(60) }, plain, NOW).findings.length, 1)
    assert.equal(evaluateEpicStalls(views(), { 'app#100': minutesAgo(59) }, plain, NOW).findings.length, 0)
  })
})

describe('one line of the merged notification (the reason it is stalled)', () => {
  const lineOf = (items: Parameters<typeof snapshot>[0]) =>
    evaluateEpicStalls(epicViews(snapshot(items), [idle('SWE1')], enabled), { 'app#100': minutesAgo(61) }, enabled, NOW).owner[0]?.owner?.line

  it('when there are no In Progress children, writes the count of Next and Backlog children', () => {
    assert.equal(lineOf([epic(), child(101, { status: 'Next' }), child(102, { status: 'Backlog' }), child(103, { status: 'Backlog' })]), 'nobody is moving app#100 "Epic 100" for 61 minutes (no children In Progress (Next 1, Backlog 2))')
  })

  it('when there are In Progress children, writes that count and the reason they are stalled (without repeating it)', () => {
    assert.equal(lineOf([epic(), doing(101, null, 'External wait'), doing(102, null, 'External wait'), doing(103, null, 'None')]), 'nobody is moving app#100 "Epic 100" for 61 minutes (In Progress children are blocked (3): External wait, None)')
  })

  it("when all In Progress children are waiting for a decision, writes that they wait for the owner's answer and the numbers of those children", () => {
    assert.equal(lineOf([epic(), doing(101, 'SWE1', 'Needs decision'), doing(102, 'SWE1', 'Needs decision')]), 'nobody is moving app#100 "Epic 100" for 61 minutes (waiting for the owner\'s answer (app#101, app#102))')
  })
})
