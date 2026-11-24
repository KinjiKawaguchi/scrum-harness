import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateMembers, parseSessionFile } from '../src/team/state.ts'
import type { SessionSignal } from '../src/team/types.ts'

function signal(overrides: Partial<SessionSignal>): SessionSignal {
  return {
    sessionId: 's1',
    name: 'SWE1',
    state: 'idle',
    since: '2026-10-08T05:00:00.000Z',
    updatedAt: '2026-10-08T05:00:00.000Z',
    isAlive: true,
    nameSince: null,
    ...overrides,
  }
}

describe('aggregateMembers', () => {
  it('信号の無い部下は unknown', () => {
    assert.deepEqual(aggregateMembers([], ['SWE1']), [{ name: 'SWE1', state: 'unknown', since: null }])
  })

  it('同じセッションの信号は更新の新しいほうを採る', () => {
    const old = signal({ state: 'busy', since: '2026-10-08T04:00:00.000Z', updatedAt: '2026-10-08T04:30:00.000Z' })
    const fresh = signal({ state: 'idle', since: '2026-10-08T05:00:00.000Z', updatedAt: '2026-10-08T05:00:00.000Z' })
    assert.deepEqual(aggregateMembers([old, fresh], ['SWE1']), [
      { name: 'SWE1', state: 'idle', since: '2026-10-08T05:00:00.000Z' },
    ])
  })

  it('同じ名前のセッションは、名前を後から取ったほうを採る (ListAgents と同じ)', () => {
    const abandoned = signal({ sessionId: 'a', state: 'busy', nameSince: '2026-09-27T00:00:00.000Z' })
    const current = signal({ sessionId: 'b', state: 'idle', since: '2026-10-08T05:20:00.000Z', nameSince: '2026-10-03T00:00:00.000Z' })
    assert.deepEqual(aggregateMembers([abandoned, current], ['SWE1'])[0], {
      name: 'SWE1',
      state: 'idle',
      since: '2026-10-08T05:20:00.000Z',
    })
  })

  it('心拍には名前を取った時刻が無いので、同じセッションの記録から引き継ぐ', () => {
    const record = signal({ sessionId: 'b', state: 'busy', updatedAt: '2026-10-08T05:00:00.000Z', nameSince: '2026-10-03T00:00:00.000Z' })
    const beat = signal({ sessionId: 'b', state: 'idle', since: '2026-10-08T05:30:00.000Z', updatedAt: '2026-10-08T05:30:00.000Z' })
    const abandoned = signal({ sessionId: 'a', state: 'busy', nameSince: '2026-09-27T00:00:00.000Z' })
    assert.equal(aggregateMembers([abandoned, record, beat], ['SWE1'])[0]?.state, 'idle')
  })

  it('死んだセッションと終わったセッションは数えない', () => {
    const dead = signal({ sessionId: 'a', state: 'busy', isAlive: false })
    const ended = signal({ sessionId: 'b', state: 'ended' })
    assert.equal(aggregateMembers([dead, ended], ['SWE1'])[0]?.state, 'unknown')
  })
})

describe('parseSessionFile', () => {
  const raw = {
    pid: 123,
    sessionId: 'abc',
    name: 'SWE3',
    status: 'idle',
    statusUpdatedAt: Date.parse('2026-10-08T05:00:00.000Z'),
    nameSince: Date.parse('2026-10-03T00:00:00.000Z'),
  }

  it('Claude Code のセッションの記録を信号に変える', () => {
    assert.deepEqual(parseSessionFile(raw, () => true), {
      sessionId: 'abc',
      name: 'SWE3',
      state: 'idle',
      since: '2026-10-08T05:00:00.000Z',
      updatedAt: '2026-10-08T05:00:00.000Z',
      isAlive: true,
      nameSince: '2026-10-03T00:00:00.000Z',
    })
  })

  it('shell は作業中とみなす', () => {
    assert.equal(parseSessionFile({ ...raw, status: 'shell' }, () => true)?.state, 'busy')
  })

  it('名前や状態が無ければ捨てる', () => {
    assert.equal(parseSessionFile({ ...raw, name: undefined }, () => true), null)
    assert.equal(parseSessionFile({ ...raw, status: 'mystery' }, () => true), null)
  })

  it('プロセスが生きているかを pid で見る', () => {
    assert.equal(parseSessionFile(raw, (pid) => pid !== 123)?.isAlive, false)
  })
})
