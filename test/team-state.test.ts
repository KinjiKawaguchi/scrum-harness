import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionFile } from '../src/adapters/claude-code/sessions.ts'
import { aggregateMembers } from '../src/team/state.ts'
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
  it('a member with no signal is unknown', () => {
    assert.deepEqual(aggregateMembers([], ['SWE1']), [{ name: 'SWE1', state: 'unknown', since: null }])
  })

  it('for signals of the same session, takes the more recently updated one', () => {
    const old = signal({ state: 'busy', since: '2026-10-08T04:00:00.000Z', updatedAt: '2026-10-08T04:30:00.000Z' })
    const fresh = signal({ state: 'idle', since: '2026-10-08T05:00:00.000Z', updatedAt: '2026-10-08T05:00:00.000Z' })
    assert.deepEqual(aggregateMembers([old, fresh], ['SWE1']), [
      { name: 'SWE1', state: 'idle', since: '2026-10-08T05:00:00.000Z' },
    ])
  })

  it('for sessions of the same name, takes the one whose name was obtained later (the same as ListAgents)', () => {
    const abandoned = signal({ sessionId: 'a', state: 'busy', nameSince: '2026-09-27T00:00:00.000Z' })
    const current = signal({ sessionId: 'b', state: 'idle', since: '2026-10-08T05:20:00.000Z', nameSince: '2026-10-03T00:00:00.000Z' })
    assert.deepEqual(aggregateMembers([abandoned, current], ['SWE1'])[0], {
      name: 'SWE1',
      state: 'idle',
      since: '2026-10-08T05:20:00.000Z',
    })
  })

  it("a heartbeat has no time when the name was obtained, so it is carried over from the same session's record", () => {
    const record = signal({ sessionId: 'b', state: 'busy', updatedAt: '2026-10-08T05:00:00.000Z', nameSince: '2026-10-03T00:00:00.000Z' })
    const beat = signal({ sessionId: 'b', state: 'idle', since: '2026-10-08T05:30:00.000Z', updatedAt: '2026-10-08T05:30:00.000Z' })
    const abandoned = signal({ sessionId: 'a', state: 'busy', nameSince: '2026-09-27T00:00:00.000Z' })
    assert.equal(aggregateMembers([abandoned, record, beat], ['SWE1'])[0]?.state, 'idle')
  })

  it('does not count dead sessions or finished sessions', () => {
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

  it('turns a Claude Code session record into a signal', () => {
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

  it('treats shell as In Progress', () => {
    assert.equal(parseSessionFile({ ...raw, status: 'shell' }, () => true)?.state, 'busy')
  })

  it('drops entries with no name or state', () => {
    assert.equal(parseSessionFile({ ...raw, name: undefined }, () => true), null)
    assert.equal(parseSessionFile({ ...raw, status: 'mystery' }, () => true), null)
  })

  it('checks whether a process is alive by pid', () => {
    assert.equal(parseSessionFile(raw, (pid) => pid !== 123)?.isAlive, false)
  })
})
