import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lintTeam } from '../src/team/rules.ts'
import type { MemberState } from '../src/team/types.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()

function member(name: string, state: MemberState['state'], minutes: number): MemberState {
  return { name, state, since: minutesAgo(minutes) }
}

const board = snapshot([
  issue(240, { status: 'In Progress', assignee: 'SWE3' }),
  issue(11, { status: 'Next' }),
  issue(12, { status: 'Next' }),
])

describe('lintTeam', () => {
  it('makes T-IDLE of a member who has been idle beyond the threshold', () => {
    const [finding, ...rest] = lintTeam([member('SWE3', 'idle', 55)], board, config, NOW)
    assert.equal(rest.length, 0)
    assert.equal(finding?.rule, 'T-IDLE')
    assert.equal(finding?.severity, 'high')
    assert.match(finding?.message ?? '', /SWE3 has been idle for 55 minutes/)
    assert.match(finding?.message ?? '', /Their In Progress: app#240/)
    assert.match(finding?.message ?? '', /Next: app#11 app#12/)
  })

  it('does not emit when the idle time is under the threshold', () => {
    assert.deepEqual(lintTeam([member('SWE3', 'idle', 9)], board, config, NOW), [])
  })

  it('the fingerprint changes per idle period', () => {
    const first = lintTeam([member('SWE3', 'idle', 55)], board, config, NOW)[0]
    const second = lintTeam([member('SWE3', 'idle', 12)], board, config, NOW)[0]
    assert.notEqual(first?.key, second?.key)
  })

  it('makes T-WAITING of a member who keeps waiting for permission', () => {
    const findings = lintTeam([member('SWE1', 'waiting', 6)], board, config, NOW)
    assert.deepEqual(findings.map((f) => `${f.rule} ${f.severity}`), ['T-WAITING high'])
  })

  it('makes T-BUSY-UNTRACKED of a member who has been moving for long with no In Progress item assigned to them', () => {
    const findings = lintTeam([member('SWE1', 'busy', 31)], board, config, NOW)
    assert.deepEqual(findings.map((f) => `${f.rule} ${f.severity}`), ['T-BUSY-UNTRACKED low'])
  })

  it('emits nothing for a member who is moving when they have an assigned In Progress item', () => {
    assert.deepEqual(lintTeam([member('SWE3', 'busy', 120)], board, config, NOW), [])
  })

  it('emits nothing for a member whose state is unknown', () => {
    assert.deepEqual(lintTeam([{ name: 'SWE2', state: 'unknown', since: null }], board, config, NOW), [])
  })
})

describe('naming configuration', () => {
  it('uses the configured name in the fix for waiting for permission', () => {
    const named = { ...config, ownerLabel: 'PM' }
    const [finding] = lintTeam([member('SWE1', 'waiting', 6)], board, named, NOW)
    assert.match(finding?.fix ?? '', /^Tell PM \(PushNotification\)/)
  })
})
