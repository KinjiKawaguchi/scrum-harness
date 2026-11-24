import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ownDoingIssue } from '../src/dispatch/choose.ts'
import { decideAction } from '../src/dispatch/decide.ts'
import { boardToken } from '../src/dispatch/progress.ts'
import type { BoardItem } from '../src/board/types.ts'
import type { DispatchRecord } from '../src/dispatch/types.ts'
import type { MemberState } from '../src/team/types.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

const enabled = { ...config, dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], utcOffset: '+09:00', notes: [] } }
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()

const idle: MemberState = { name: 'SWE1', state: 'idle', since: minutesAgo(30) }
const nudge = (minutes: number, member = 'SWE1'): DispatchRecord => ({ kind: 'nudge', at: minutesAgo(minutes), member, label: 'app#240', title: 'issue 240' })
const dispatched = (minutes: number): DispatchRecord => ({ at: minutesAgo(minutes), member: 'SWE1', label: 'app#240', title: 'issue 240' })

const doing = (number: number, overrides: Parameters<typeof issue>[1] = {}) => issue(number, { status: 'In Progress', assignee: 'SWE1', ...overrides })
const next = (number: number, overrides: Parameters<typeof issue>[1] = {}) => issue(number, { status: 'Next', ...overrides })

describe('ownDoingIssue', () => {
  it('returns one In Progress issue of that person that is not stalled, smallest number first', () => {
    assert.equal(ownDoingIssue(snapshot([doing(250), doing(240)]), 'SWE1', enabled)?.number, 240)
  })

  it('does not return an item that is stalled, assigned to someone else, closed, or a PR', () => {
    const items = [doing(1, { reason: 'Needs decision' }), doing(2, { assignee: 'SWE2' }), doing(3, { state: 'CLOSED' }), doing(4, { reason: null })]
    assert.equal(ownDoingIssue(snapshot(items), 'SWE1', enabled), null)
  })
})

describe('decideAction', () => {
  it('when there is own In Progress issue that is not stalled, does not hand over a new issue and nudges instead', () => {
    const action = decideAction(snapshot([doing(240), next(11)]), idle, [], enabled, NOW)
    assert.deepEqual(action.kind === 'nudge' ? [action.kind, action.item.number, action.count] : action.kind, ['nudge', 240, 1])
  })

  it('when the In Progress work is stalled (a reason other than none), hands over the next issue', () => {
    const action = decideAction(snapshot([doing(240, { reason: 'External wait' }), next(11)]), idle, [], enabled, NOW)
    assert.deepEqual(action.kind === 'dispatch' ? [action.kind, action.item.number] : action.kind, ['dispatch', 11])
  })

  it('when there is no In Progress work, hands over the next issue', () => {
    const action = decideAction(snapshot([next(11)]), idle, [], enabled, NOW)
    assert.equal(action.kind, 'dispatch')
  })

  it('even when In Progress has reached the limit, nudges if the member has own In Progress work (the limit applies only when handing over a new issue)', () => {
    const others = Array.from({ length: config.wipLimit }, (_, index) => issue(100 + index, { status: 'In Progress', assignee: 'SWE2' }))
    assert.equal(decideAction(snapshot([...others, doing(240)]), idle, [], enabled, NOW).kind, 'nudge')
    assert.deepEqual(decideAction(snapshot([...others, next(11)]), idle, [], enabled, NOW), { kind: 'none', reason: 'wip-limit' })
  })

  it('the wait for the nudge interval is checked before the limit (until idleMinutes passes, it waits even at the limit)', () => {
    assert.deepEqual(decideAction(snapshot([doing(240)]), idle, [nudge(25), nudge(config.idleMinutes - 1)], enabled, NOW), { kind: 'none', reason: 'nudge-wait' })
  })

  it('does not send nudges back to back until idleMinutes passes since the last one; sends the second one once it has passed', () => {
    const board = snapshot([doing(240)])
    assert.deepEqual(decideAction(board, idle, [nudge(config.idleMinutes - 1)], enabled, NOW), { kind: 'none', reason: 'nudge-wait' })
    const second = decideAction(board, idle, [nudge(config.idleMinutes)], enabled, NOW)
    assert.deepEqual(second.kind === 'nudge' ? second.count : second.kind, 2)
  })

  it('does not nudge while work is progressing (the marker differs from the one seen before); returns the marker and the issue so the marker seen is remembered', () => {
    const board = snapshot([doing(240)])
    const seen = { 'SWE1|app#240': { token: { board: boardToken(ownDoingIssue(board, 'SWE1', enabled)!), github: 'a' }, at: minutesAgo(30) } }
    const token = { board: boardToken(ownDoingIssue(board, 'SWE1', enabled)!), github: 'b' }
    const action = decideAction(board, idle, [], enabled, NOW, () => token, seen)
    assert.deepEqual(action.kind === 'none' && action.reason === 'progressing' ? [action.item.number, action.token] : action, [240, token])
  })

  it('even when the marker has not changed, does not nudge until idleMinutes has passed since it last changed; nudges once it has', () => {
    const board = snapshot([doing(240)])
    const token = { board: boardToken(ownDoingIssue(board, 'SWE1', enabled)!), github: 'a' }
    const seenAt = (minutes: number) => ({ 'SWE1|app#240': { token, at: minutesAgo(minutes) } })
    assert.equal(decideAction(board, idle, [], enabled, NOW, () => token, seenAt(config.idleMinutes - 1)).kind, 'none')
    assert.equal(decideAction(board, idle, [], enabled, NOW, () => token, seenAt(config.idleMinutes)).kind, 'nudge')
  })

  it('progress is checked before the nudge limit; even after 2 nudges, waits if work progressed (the limit applies only after 2 in a row without progress)', () => {
    const board = snapshot([doing(240)])
    const base = { board: boardToken(ownDoingIssue(board, 'SWE1', enabled)!), github: 'a' }
    const progressed = decideAction(board, idle, [nudge(25), nudge(12)], enabled, NOW, () => ({ ...base, github: 'b' }), { 'SWE1|app#240': { token: base, at: minutesAgo(25) } })
    assert.deepEqual(progressed.kind === 'none' ? progressed.reason : progressed.kind, 'progressing')
    const stuck = decideAction(board, idle, [nudge(25), nudge(12)], enabled, NOW, () => base, { 'SWE1|app#240': { token: base, at: minutesAgo(25) } })
    assert.deepEqual(stuck, { kind: 'none', reason: 'nudge-limit' })
  })

  it('when there is no marker seen (first time) or only one for another issue, nudges as usual', () => {
    const board = snapshot([doing(240)])
    const token = { board: boardToken(ownDoingIssue(board, 'SWE1', enabled)!), github: 'a' }
    assert.equal(decideAction(board, idle, [], enabled, NOW, () => token, {}).kind, 'nudge')
    assert.equal(decideAction(board, idle, [], enabled, NOW, () => token, { 'SWE1|app#999': { token, at: minutesAgo(0) } }).kind, 'nudge')
    assert.equal(decideAction(board, idle, [], enabled, NOW, () => token, { 'SWE2|app#240': { token, at: minutesAgo(0) } }).kind, 'nudge')
  })

  it('after sending 2 nudges, sends no more (reports to the TechLead)', () => {
    const records = [nudge(25), nudge(12)]
    assert.deepEqual(decideAction(snapshot([doing(240)]), idle, records, enabled, NOW), { kind: 'none', reason: 'nudge-limit' })
  })

  it('keeps counting nudges when the idle period changes (even after returning to idle in a short 1-turn run) as long as work has not progressed', () => {
    const lateIdle: MemberState = { name: 'SWE1', state: 'idle', since: minutesAgo(15) }
    assert.deepEqual(decideAction(snapshot([doing(240)]), lateIdle, [nudge(90), nudge(60)], enabled, NOW), { kind: 'none', reason: 'nudge-limit' })
    const action = decideAction(snapshot([doing(240)]), lateIdle, [nudge(90)], enabled, NOW)
    assert.deepEqual(action.kind === 'nudge' ? action.count : action.kind, 2)
  })

  it('restarts counting when work progressed after a nudge (the board marker changed)', () => {
    const lateIdle: MemberState = { name: 'SWE1', state: 'idle', since: minutesAgo(15) }
    const withToken = (minutes: number, board: string) => ({ ...nudge(minutes), progress: { board, github: null } })
    const board = snapshot([doing(240)])
    const nowBoard = boardToken(board.items[0] as BoardItem)
    const progressed = decideAction(board, lateIdle, [withToken(90, 'old'), withToken(60, 'older')], enabled, NOW)
    assert.deepEqual(progressed.kind === 'nudge' ? progressed.count : progressed.kind, 1)
    const stuck = decideAction(board, lateIdle, [withToken(90, nowBoard), withToken(60, nowBoard)], enabled, NOW)
    assert.deepEqual(stuck, { kind: 'none', reason: 'nudge-limit' })
  })

  it("restarts counting when the gh marker (the PR's head commit, comments) changed after a nudge; when the gh marker cannot be read, compares by the board marker alone", () => {
    const lateIdle: MemberState = { name: 'SWE1', state: 'idle', since: minutesAgo(15) }
    const board = snapshot([doing(240)])
    const same = boardToken(board.items[0] as BoardItem)
    const withGithub = (minutes: number, github: string | null) => ({ ...nudge(minutes), progress: { board: same, github } })
    const records = [withGithub(90, 'a'), withGithub(60, 'a')]
    const changed = decideAction(board, lateIdle, records, enabled, NOW, () => ({ board: same, github: 'b' }))
    assert.deepEqual(changed.kind === 'nudge' ? changed.count : changed.kind, 1)
    const unknown = decideAction(board, lateIdle, records, enabled, NOW, () => ({ board: same, github: null }))
    assert.deepEqual(unknown, { kind: 'none', reason: 'nudge-limit' })
  })

  it('does not count nudges older than 3 hours; does not count nudges for other issues either', () => {
    const lateIdle: MemberState = { name: 'SWE1', state: 'idle', since: minutesAgo(15) }
    const board = snapshot([doing(240)])
    assert.equal(decideAction(board, lateIdle, [nudge(300), nudge(200)], enabled, NOW).kind, 'nudge')
    const other = (minutes: number): DispatchRecord => ({ ...nudge(minutes), label: 'app#999' })
    assert.deepEqual(decideAction(board, lateIdle, [other(90), other(60)], enabled, NOW), { kind: 'nudge', item: board.items[0], count: 1, token: { board: boardToken(board.items[0] as BoardItem), github: null } })
  })

  it('8 rounds: even if the member returns to idle 2 minutes after each nudge, it stops after 2 nudges as long as work does not progress', () => {
    const board = snapshot([doing(240)])
    const records: DispatchRecord[] = []
    const kinds: string[] = []
    for (let round = 0; round < 8; round++) {
      const at = new Date(NOW.getTime() + round * 12 * 60_000)
      const member: MemberState = { name: 'SWE1', state: 'idle', since: new Date(at.getTime() - 10 * 60_000).toISOString() }
      const action = decideAction(board, member, records, enabled, at)
      kinds.push(action.kind === 'none' ? action.reason : action.kind)
      if (action.kind === 'nudge') records.push({ kind: 'nudge', at: at.toISOString(), member: 'SWE1', label: 'app#240', title: 't', progress: action.token })
    }
    assert.deepEqual(kinds, ['nudge', 'nudge', 'nudge-limit', 'nudge-limit', 'nudge-limit', 'nudge-limit', 'nudge-limit', 'nudge-limit'])
  })

  it('right after handing over a new issue, does not nudge on top of it and waits idleMinutes', () => {
    const board = snapshot([doing(240)])
    assert.deepEqual(decideAction(board, idle, [dispatched(1)], enabled, NOW), { kind: 'none', reason: 'nudge-wait' })
    assert.equal(decideAction(board, idle, [dispatched(config.idleMinutes)], enabled, NOW).kind, 'nudge')
  })

  it('when there is no In Progress work and the member is still not moving after a hand-over, does not hand over again; nudge records are not counted', () => {
    const board = snapshot([next(11)])
    assert.deepEqual(decideAction(board, idle, [dispatched(5)], enabled, NOW), { kind: 'none', reason: 'already-dispatched' })
    assert.equal(decideAction(board, idle, [nudge(5)], enabled, NOW).kind, 'dispatch')
  })
})
