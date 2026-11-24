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
  it('閾値を超えて空いている部下を T-IDLE にする', () => {
    const [finding, ...rest] = lintTeam([member('SWE3', 'idle', 55)], board, config, NOW)
    assert.equal(rest.length, 0)
    assert.equal(finding?.rule, 'T-IDLE')
    assert.equal(finding?.severity, 'high')
    assert.match(finding?.message ?? '', /SWE3 has been idle for 55 minutes/)
    assert.match(finding?.message ?? '', /Their In Progress: app#240/)
    assert.match(finding?.message ?? '', /Next: app#11 app#12/)
  })

  it('空きが閾値未満なら出さない', () => {
    assert.deepEqual(lintTeam([member('SWE3', 'idle', 9)], board, config, NOW), [])
  })

  it('空きの区間ごとに指紋が変わる', () => {
    const first = lintTeam([member('SWE3', 'idle', 55)], board, config, NOW)[0]
    const second = lintTeam([member('SWE3', 'idle', 12)], board, config, NOW)[0]
    assert.notEqual(first?.key, second?.key)
  })

  it('許可待ちが続く部下を T-WAITING にする', () => {
    const findings = lintTeam([member('SWE1', 'waiting', 6)], board, config, NOW)
    assert.deepEqual(findings.map((f) => `${f.rule} ${f.severity}`), ['T-WAITING high'])
  })

  it('担当の作業中が無いまま長く動いている部下を T-BUSY-UNTRACKED にする', () => {
    const findings = lintTeam([member('SWE1', 'busy', 31)], board, config, NOW)
    assert.deepEqual(findings.map((f) => `${f.rule} ${f.severity}`), ['T-BUSY-UNTRACKED low'])
  })

  it('担当の作業中があれば動いていても何も出さない', () => {
    assert.deepEqual(lintTeam([member('SWE3', 'busy', 120)], board, config, NOW), [])
  })

  it('状態の分からない部下には何も出さない', () => {
    assert.deepEqual(lintTeam([{ name: 'SWE2', state: 'unknown', since: null }], board, config, NOW), [])
  })
})

describe('呼び方の設定', () => {
  it('許可待ちの直し方に、設定の呼び方を使う', () => {
    const named = { ...config, ownerLabel: 'PM' }
    const [finding] = lintTeam([member('SWE1', 'waiting', 6)], board, named, NOW)
    assert.match(finding?.fix ?? '', /^Tell PM \(PushNotification\)/)
  })
})
