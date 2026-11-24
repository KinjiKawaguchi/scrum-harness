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

const doing = (number: number, overrides: Parameters<typeof issue>[1] = {}) => issue(number, { status: '作業中', tanto: 'SWE1', ...overrides })
const next = (number: number, overrides: Parameters<typeof issue>[1] = {}) => issue(number, { status: '次にやる', ...overrides })

describe('ownDoingIssue', () => {
  it('その人の作業中で、止まっていない issue を、番号の小さい順に 1 つ返す', () => {
    assert.equal(ownDoingIssue(snapshot([doing(250), doing(240)]), 'SWE1', enabled)?.number, 240)
  })

  it('止まっている、担当が別の人、閉じた、PR のものは返さない', () => {
    const items = [doing(1, { reason: '判断待ち' }), doing(2, { tanto: 'SWE2' }), doing(3, { state: 'CLOSED' }), doing(4, { reason: null })]
    assert.equal(ownDoingIssue(snapshot(items), 'SWE1', enabled), null)
  })
})

describe('decideAction', () => {
  it('止まっていない自分の作業中の issue があれば、新しい issue は渡さず、促す', () => {
    const action = decideAction(snapshot([doing(240), next(11)]), idle, [], enabled, NOW)
    assert.deepEqual(action.kind === 'nudge' ? [action.kind, action.item.number, action.count] : action.kind, ['nudge', 240, 1])
  })

  it('作業中が止まっていれば (理由がなし以外)、次の issue を渡す', () => {
    const action = decideAction(snapshot([doing(240, { reason: '外部待ち' }), next(11)]), idle, [], enabled, NOW)
    assert.deepEqual(action.kind === 'dispatch' ? [action.kind, action.item.number] : action.kind, ['dispatch', 11])
  })

  it('作業中が無ければ、次の issue を渡す', () => {
    const action = decideAction(snapshot([next(11)]), idle, [], enabled, NOW)
    assert.equal(action.kind, 'dispatch')
  })

  it('作業中が上限に届いていても、自分の作業中があれば促す (上限は新しい issue を渡すときだけ)', () => {
    const others = Array.from({ length: config.wipLimit }, (_, index) => issue(100 + index, { status: '作業中', tanto: 'SWE2' }))
    assert.equal(decideAction(snapshot([...others, doing(240)]), idle, [], enabled, NOW).kind, 'nudge')
    assert.deepEqual(decideAction(snapshot([...others, next(11)]), idle, [], enabled, NOW), { kind: 'none', reason: 'wip-limit' })
  })

  it('促しの間隔の待ちは、上限より先に見る (idleMinutes 経つまでは、上限でも待つ)', () => {
    assert.deepEqual(decideAction(snapshot([doing(240)]), idle, [nudge(25), nudge(config.idleMinutes - 1)], enabled, NOW), { kind: 'none', reason: 'nudge-wait' })
  })

  it('促しは、最後に送ってから idleMinutes 経つまで、重ねて送らない。経てば 2 回目を送る', () => {
    const board = snapshot([doing(240)])
    assert.deepEqual(decideAction(board, idle, [nudge(config.idleMinutes - 1)], enabled, NOW), { kind: 'none', reason: 'nudge-wait' })
    const second = decideAction(board, idle, [nudge(config.idleMinutes)], enabled, NOW)
    assert.deepEqual(second.kind === 'nudge' ? second.count : second.kind, 2)
  })

  it('作業が進んでいる (前に見た印から変わった) 間は促さない。印と issue を返し、見た印を覚えさせる', () => {
    const board = snapshot([doing(240)])
    const seen = { 'SWE1|app#240': { token: { board: boardToken(ownDoingIssue(board, 'SWE1', enabled)!), github: 'a' }, at: minutesAgo(30) } }
    const token = { board: boardToken(ownDoingIssue(board, 'SWE1', enabled)!), github: 'b' }
    const action = decideAction(board, idle, [], enabled, NOW, () => token, seen)
    assert.deepEqual(action.kind === 'none' && action.reason === 'progressing' ? [action.item.number, action.token] : action, [240, token])
  })

  it('印が変わっていなくても、最後に印が変わってから idleMinutes たっていなければ、促さない。たてば促す', () => {
    const board = snapshot([doing(240)])
    const token = { board: boardToken(ownDoingIssue(board, 'SWE1', enabled)!), github: 'a' }
    const seenAt = (minutes: number) => ({ 'SWE1|app#240': { token, at: minutesAgo(minutes) } })
    assert.equal(decideAction(board, idle, [], enabled, NOW, () => token, seenAt(config.idleMinutes - 1)).kind, 'none')
    assert.equal(decideAction(board, idle, [], enabled, NOW, () => token, seenAt(config.idleMinutes)).kind, 'nudge')
  })

  it('進んでいるかは、促しの上限より先に見る。2 回促した後でも、進んだなら待つ (進まないまま 2 回続けたときだけ、上限)', () => {
    const board = snapshot([doing(240)])
    const base = { board: boardToken(ownDoingIssue(board, 'SWE1', enabled)!), github: 'a' }
    const progressed = decideAction(board, idle, [nudge(25), nudge(12)], enabled, NOW, () => ({ ...base, github: 'b' }), { 'SWE1|app#240': { token: base, at: minutesAgo(25) } })
    assert.deepEqual(progressed.kind === 'none' ? progressed.reason : progressed.kind, 'progressing')
    const stuck = decideAction(board, idle, [nudge(25), nudge(12)], enabled, NOW, () => base, { 'SWE1|app#240': { token: base, at: minutesAgo(25) } })
    assert.deepEqual(stuck, { kind: 'none', reason: 'nudge-limit' })
  })

  it('見た印が無い (初めて) か、別の issue の分だけなら、これまでどおり促す', () => {
    const board = snapshot([doing(240)])
    const token = { board: boardToken(ownDoingIssue(board, 'SWE1', enabled)!), github: 'a' }
    assert.equal(decideAction(board, idle, [], enabled, NOW, () => token, {}).kind, 'nudge')
    assert.equal(decideAction(board, idle, [], enabled, NOW, () => token, { 'SWE1|app#999': { token, at: minutesAgo(0) } }).kind, 'nudge')
    assert.equal(decideAction(board, idle, [], enabled, NOW, () => token, { 'SWE2|app#240': { token, at: minutesAgo(0) } }).kind, 'nudge')
  })

  it('促しを 2 回送ったら、それ以上は送らない (TechLead に出す)', () => {
    const records = [nudge(25), nudge(12)]
    assert.deepEqual(decideAction(snapshot([doing(240)]), idle, records, enabled, NOW), { kind: 'none', reason: 'nudge-limit' })
  })

  it('空きの区間が変わっても (短い 1 ターンで空きに戻っても)、作業が進んでいなければ、促しを続けて数える', () => {
    const lateIdle: MemberState = { name: 'SWE1', state: 'idle', since: minutesAgo(15) }
    assert.deepEqual(decideAction(snapshot([doing(240)]), lateIdle, [nudge(90), nudge(60)], enabled, NOW), { kind: 'none', reason: 'nudge-limit' })
    const action = decideAction(snapshot([doing(240)]), lateIdle, [nudge(90)], enabled, NOW)
    assert.deepEqual(action.kind === 'nudge' ? action.count : action.kind, 2)
  })

  it('促しの後に作業が進んだなら (ボードの印が変わった)、数え直す', () => {
    const lateIdle: MemberState = { name: 'SWE1', state: 'idle', since: minutesAgo(15) }
    const withToken = (minutes: number, board: string) => ({ ...nudge(minutes), progress: { board, github: null } })
    const board = snapshot([doing(240)])
    const nowBoard = boardToken(board.items[0] as BoardItem)
    const progressed = decideAction(board, lateIdle, [withToken(90, 'old'), withToken(60, 'older')], enabled, NOW)
    assert.deepEqual(progressed.kind === 'nudge' ? progressed.count : progressed.kind, 1)
    const stuck = decideAction(board, lateIdle, [withToken(90, nowBoard), withToken(60, nowBoard)], enabled, NOW)
    assert.deepEqual(stuck, { kind: 'none', reason: 'nudge-limit' })
  })

  it('促しの後に、gh の印 (PR の先頭のコミット、コメント) が変わったなら、数え直す。gh の印が読めなければ、ボードの印だけで比べる', () => {
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

  it('3 時間より前の促しは数えない。ほかの issue への促しも数えない', () => {
    const lateIdle: MemberState = { name: 'SWE1', state: 'idle', since: minutesAgo(15) }
    const board = snapshot([doing(240)])
    assert.equal(decideAction(board, lateIdle, [nudge(300), nudge(200)], enabled, NOW).kind, 'nudge')
    const other = (minutes: number): DispatchRecord => ({ ...nudge(minutes), label: 'app#999' })
    assert.deepEqual(decideAction(board, lateIdle, [other(90), other(60)], enabled, NOW), { kind: 'nudge', item: board.items[0], count: 1, token: { board: boardToken(board.items[0] as BoardItem), github: null } })
  })

  it('8 周: 促しの後、2 分で空きに戻るのを繰り返しても、作業が進まなければ、2 回で止まる', () => {
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

  it('新しい issue を渡した直後は、重ねて促さず、idleMinutes 待つ', () => {
    const board = snapshot([doing(240)])
    assert.deepEqual(decideAction(board, idle, [dispatched(1)], enabled, NOW), { kind: 'none', reason: 'nudge-wait' })
    assert.equal(decideAction(board, idle, [dispatched(config.idleMinutes)], enabled, NOW).kind, 'nudge')
  })

  it('作業中が無いとき、渡した後に動かないままなら、重ねて渡さない。促しの記録は数えない', () => {
    const board = snapshot([next(11)])
    assert.deepEqual(decideAction(board, idle, [dispatched(5)], enabled, NOW), { kind: 'none', reason: 'already-dispatched' })
    assert.equal(decideAction(board, idle, [nudge(5)], enabled, NOW).kind, 'dispatch')
  })
})
