import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseItemPages } from '../src/adapters/github/project-board.ts'
import { parseConfig } from '../src/config.ts'
import { boardToken } from '../src/dispatch/progress.ts'
import { lintDispatch } from '../src/dispatch/rules.ts'
import type { Ack } from '../src/findings/acks.ts'
import type { BoardItem } from '../src/board/types.ts'
import type { DispatchRecord } from '../src/dispatch/types.ts'
import { lintAll } from '../src/findings/lint.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const record = (minutes: number, label = 'app#11'): DispatchRecord => ({ at: minutesAgo(minutes), member: 'SWE1', label, title: 'Next job' })

function pageOf(node: unknown) {
  return [{ data: { node: { items: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } } } }]
}

const baseNode = {
  id: 'PVTI_1',
  type: 'ISSUE',
  status: { name: 'Next' },
  content: { number: 11, title: 'issue 11', state: 'OPEN', author: { login: 'owner' }, repository: { nameWithOwner: 'example-org/app' } },
}

describe('hand-over order, labels, and parent issue of the fetch result', () => {
  it('when fetched, puts them into the item (the parent is "<repository name>#number")', () => {
    const [item] = parseItemPages(
      JSON.stringify(
        pageOf({
          ...baseNode,
          order: { number: 3 },
          content: { ...baseNode.content, labels: { nodes: [{ name: 'skip-me' }, { name: 'bug' }] }, parent: { number: 100, repository: { nameWithOwner: 'example-org/app' } } },
        }),
      ),
    )
    assert.deepEqual([item?.order, item?.labels, item?.epic], [3, ['skip-me', 'bug'], 'app#100'])
  })

  it('an issue without a parent has epic null, and an empty order field makes order null', () => {
    const [item] = parseItemPages(JSON.stringify(pageOf({ ...baseNode, order: null, content: { ...baseNode.content, labels: { nodes: [] }, parent: null } })))
    assert.deepEqual([item?.order, item?.labels, item?.epic], [null, [], null])
  })

  it('when not fetched, adds no keys (the board copy of a board that does not use dispatch is unchanged)', () => {
    const [item] = parseItemPages(JSON.stringify(pageOf(baseNode)))
    assert.equal('order' in (item ?? {}), false)
    assert.equal('labels' in (item ?? {}), false)
    assert.equal('epic' in (item ?? {}), false)
  })
})

describe('dispatch of parseConfig', () => {
  const { sprint: _s, ...project } = config as typeof config & { sprint?: unknown }

  it('fills missing items with defaults; when enabled is missing, stops only this feature', () => {
    const parsed = parseConfig({ ...project, dispatch: { enabled: true } })
    assert.deepEqual(parsed?.dispatch, { enabled: true, baseBranch: 'main', skipLabels: [], utcOffset: '+09:00', notes: [] })
    assert.equal(parseConfig({ ...project, dispatch: { baseBranch: 'develop' } })?.dispatch, undefined)
    assert.notEqual(parseConfig({ ...project, dispatch: { baseBranch: 'develop' } }), null)
  })

  it('reads the values; when the shape is wrong, stops only this feature', () => {
    const full = { enabled: true, baseBranch: 'develop', skipLabels: ['a'], orderField: 'Order', utcOffset: '+09:00', notes: ['n'], members: ['SWE1'], scriptDir: '~/tools' }
    assert.deepEqual(parseConfig({ ...project, dispatch: full })?.dispatch, full)
    for (const bad of [{ ...full, enabled: 'yes' }, { ...full, skipLabels: [1] }, { ...full, utcOffset: '9' }, { ...full, baseBranch: '' }, { ...full, members: 'SWE1' }, { ...full, scriptDir: '' }]) {
      assert.equal(parseConfig({ ...project, dispatch: bad })?.dispatch, undefined)
    }
  })
})

describe('lintDispatch (A-DISPATCHED)', () => {
  it('turns a hand-over into a medium finding that states who was given what; the fingerprint changes per record', () => {
    const [first, second] = lintDispatch([record(10), record(20, 'app#12')], config, NOW)
    assert.deepEqual([first?.rule, first?.severity, first?.subject], ['A-DISPATCHED', 'medium', 'app#11'])
    assert.match(first?.message ?? '', /SWE1 was idle, so app#11 Next job was handed over automatically/)
    assert.notEqual(first?.key, second?.key)
  })

  it('does not emit records older than 2 hours', () => {
    assert.deepEqual(lintDispatch([record(121)], config, NOW), [])
    assert.equal(lintDispatch([record(120)], config, NOW).length, 1)
  })

  it('goes into lintAll and becomes a target of notifications to the TechLead (medium or above)', () => {
    const ctx = { snapshot: snapshot([issue(11, { status: 'In Progress', assignee: 'SWE1' })]), members: [], acks: [], config, now: NOW, dispatches: [record(5)] }
    assert.deepEqual(lintAll(ctx).active.filter((finding) => finding.rule === 'A-DISPATCHED').map((finding) => finding.severity), ['medium'])
  })
})

describe('A-NUDGE-IGNORED', () => {
  const idle = (minutes: number) => [{ name: 'SWE1', state: 'idle' as const, since: minutesAgo(minutes) }]
  const nudge = (minutes: number, progress?: DispatchRecord['progress']): DispatchRecord => ({
    kind: 'nudge',
    at: minutesAgo(minutes),
    member: 'SWE1',
    label: 'app#240',
    title: 'Ongoing job',
    ...(progress === undefined ? {} : { progress }),
  })

  it('turns a member who was nudged twice without work progressing and is still idle into a medium finding', () => {
    const [finding] = lintDispatch([nudge(40), nudge(20)], config, NOW, idle(50))
    assert.deepEqual([finding?.rule, finding?.severity, finding?.subject], ['A-NUDGE-IGNORED', 'medium', 'SWE1'])
    assert.match(finding?.message ?? '', /SWE1 was nudged 2 times to continue app#240, which is In Progress, but went back to idle with no work in between \(board change, PR or linked-branch activity\)\. Idle now for 50 minutes/)
  })

  it('keeps counting even when the idle period changes (the member returned to idle after a short 1-turn run following a nudge), and emits only once', () => {
    const records = [nudge(100), nudge(80), nudge(40)]
    const findings = lintDispatch(records, config, NOW, idle(30))
    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.key, lintDispatch([nudge(100), nudge(80)], config, NOW, idle(60))[0]?.key)
  })

  it('does not emit when there is only one nudge, when the member is moving, or when the only nudges are older than 3 hours', () => {
    assert.deepEqual(lintDispatch([nudge(20)], config, NOW, idle(50)), [])
    assert.deepEqual(lintDispatch([nudge(40), nudge(20)], config, NOW, [{ name: 'SWE1', state: 'busy', since: minutesAgo(5) }]), [])
    assert.deepEqual(lintDispatch([nudge(300), nudge(250)], config, NOW, idle(50)), [])
  })

  it('does not emit when work progressed after a nudge (the board marker changed); counting restarts from the nudge after the progress', () => {
    const board = snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })])
    const now = boardToken(board.items[0] as BoardItem)
    assert.deepEqual(lintDispatch([nudge(100, { board: 'before', github: null }), nudge(80, { board: 'before', github: null })], config, NOW, idle(50), board), [])
    assert.equal(lintDispatch([nudge(100, { board: 'before', github: null }), nudge(80, { board: now, github: null }), nudge(60, { board: now, github: null })], config, NOW, idle(50), board).length, 1)
  })

  it('counts per In Progress issue; does not mix in nudges for other issues', () => {
    const other = (minutes: number): DispatchRecord => ({ ...nudge(minutes), label: 'app#999' })
    assert.deepEqual(lintDispatch([nudge(40), other(30)], config, NOW, idle(50)), [])
    assert.deepEqual(lintDispatch([nudge(40), other(30), nudge(20)], config, NOW, idle(50)).map((finding) => finding.rule), ['A-NUDGE-IGNORED'])
  })

  it('nudges do not count toward A-DISPATCHED (only hand-over records)', () => {
    assert.deepEqual(lintDispatch([nudge(5)], config, NOW).map((finding) => finding.rule), [])
  })

  it("goes into lintAll (passing the members' activity)", () => {
    const ctx = {
      snapshot: snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })]),
      members: idle(50),
      acks: [],
      config,
      now: NOW,
      dispatches: [nudge(40), nudge(20)],
    }
    assert.deepEqual(lintAll(ctx).active.filter((finding) => finding.rule === 'A-NUDGE-IGNORED').map((finding) => finding.subject), ['SWE1'])
  })

  it('the fingerprint changes with the first time of each run of nudges (a new run after progress is emitted again)', () => {
    const first = lintDispatch([nudge(60), nudge(20)], config, NOW, idle(50))[0]
    const board = snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })])
    const progressed = lintDispatch([nudge(200, { board: 'before', github: null }), nudge(40, { board: boardToken(board.items[0] as BoardItem), github: null }), nudge(20, { board: boardToken(board.items[0] as BoardItem), github: null })], config, NOW, idle(50), board)[0]
    assert.notEqual(first?.key, progressed?.key)
  })
})

describe('stored T-IDLE acknowledgements and T-IDLE findings', () => {
  const idleMember = [{ name: 'SWE1', state: 'idle' as const, since: minutesAgo(30) }]
  const base = { snapshot: snapshot([]), members: idleMember, config, now: NOW }
  const tIdle = (acks: Ack[]) => lintAll({ ...base, acks }).active.filter((finding) => finding.rule === 'T-IDLE').map((finding) => finding.subject)
  const ack = (overrides: Partial<Ack>): Ack => ({ rule: 'T-IDLE', subject: 'SWE1', at: minutesAgo(5), until: new Date(NOW.getTime() + 55 * 60_000).toISOString(), reason: "Waiting for the owner's answer", ...overrides })

  it('an acknowledgement that passes validation (at most 1 hour, a fixed reason) silences the T-IDLE finding', () => {
    assert.deepEqual(tIdle([ack({})]), [])
  })

  it('an acknowledgement stored without having been validated (a long expiry, a spare-capacity reason, or trailing text after the reason) does not silence the T-IDLE finding', () => {
    assert.deepEqual(tIdle([ack({ reason: 'Because of spare context capacity', until: new Date(NOW.getTime() + 4 * 60 * 60_000).toISOString() })]), ['SWE1'])
    assert.deepEqual(tIdle([ack({ until: new Date(NOW.getTime() + 4 * 60 * 60_000).toISOString() })]), ['SWE1'])
    assert.deepEqual(tIdle([ack({ reason: "Waiting for the owner's answer, low capacity" })]), ['SWE1'])
  })

  it('does not validate acknowledgements of rules other than T-IDLE', () => {
    const wip = { ...ack({}), rule: 'B-WIP-OVER', reason: 'anything', until: new Date(NOW.getTime() + 40 * 60 * 60_000).toISOString() }
    assert.deepEqual(tIdle([wip, ack({ reason: 'capacity', until: NOW.toISOString() })]), ['SWE1'])
  })
})

