import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lintBoard } from '../src/board/rules.ts'
import { config, issue, NOW, pr, snapshot } from './helpers.ts'

function rulesOf(items: Parameters<typeof snapshot>[0], openIssues?: Parameters<typeof snapshot>[1]) {
  return lintBoard(snapshot(items, openIssues), config, NOW).map((f) => `${f.rule} ${f.subject}`)
}

describe('lintBoard', () => {
  it('emits B-WIP-OVER when In Progress exceeds the limit', () => {
    const doing = Array.from({ length: 11 }, (_, i) => issue(i + 1, { status: 'In Progress', assignee: 'SWE1' }))
    assert.deepEqual(rulesOf(doing), ['B-WIP-OVER board'])
  })

  it('emits nothing when In Progress is exactly at the limit', () => {
    const doing = Array.from({ length: 10 }, (_, i) => issue(i + 1, { status: 'In Progress', assignee: 'SWE1' }))
    assert.deepEqual(rulesOf(doing), [])
  })

  it('does not count the In Progress of a closed issue toward the limit', () => {
    const doing = Array.from({ length: 10 }, (_, i) => issue(i + 1, { status: 'In Progress', assignee: 'SWE1' }))
    const closed = issue(99, { status: 'In Progress', state: 'CLOSED', assignee: 'SWE1' })
    assert.deepEqual(rulesOf([...doing, closed]), ['B-CLOSED-NOT-DONE app#99'])
  })

  it('emits B-DOING-NO-ASSIGNEE when In Progress has no assignee', () => {
    assert.deepEqual(rulesOf([issue(5, { status: 'In Progress' })]), ['B-DOING-NO-ASSIGNEE app#5'])
  })

  it('emits B-CLOSED-NOT-DONE when a closed issue is not Done', () => {
    assert.deepEqual(rulesOf([issue(7, { state: 'CLOSED', status: 'Release' })]), ['B-CLOSED-NOT-DONE app#7'])
  })

  it('emits B-OPEN-DONE when an open issue is Done', () => {
    assert.deepEqual(rulesOf([issue(8, { status: 'Done' })]), ['B-OPEN-DONE app#8'])
  })

  it('emits B-PR-STATUS when a PR has a Status', () => {
    assert.deepEqual(rulesOf([pr(102, { status: 'In Progress' })]), ['B-PR-STATUS app#102'])
  })

  it('emits nothing for a PR without a Status', () => {
    assert.deepEqual(rulesOf([pr(103)]), [])
  })

  it('emits B-NO-STATUS when an open issue has no Status', () => {
    assert.deepEqual(rulesOf([issue(9, { status: null })]), ['B-NO-STATUS app#9'])
  })

  it('emits B-OFF-BOARD when an open issue is not on the board', () => {
    const openIssues = [{ repo: 'example-org/app', number: 42, author: 'owner' }]
    assert.deepEqual(rulesOf([], openIssues), ['B-OFF-BOARD app#42'])
  })

  it('emits B-NEXT-BLOCKED when a Next item is blocked', () => {
    const item = issue(10, { status: 'Next', reason: 'External wait', since: '2026-10-07' })
    assert.deepEqual(rulesOf([item]), ['B-NEXT-BLOCKED app#10'])
  })

  it('emits B-JUDGE-OWNER when the Owner of a decision-pending item is not the owner', () => {
    const item = issue(11, { reason: 'Needs decision', since: '2026-10-07', owner: 'AI' })
    assert.deepEqual(rulesOf([item]), ['B-JUDGE-OWNER app#11'])
  })

  it('emits B-SINCE-MISSING when blocked but no block-start day exists', () => {
    assert.deepEqual(rulesOf([issue(12, { reason: 'External wait' })]), ['B-SINCE-MISSING app#12'])
  })

  it('emits B-REASON-MISSING when the blocked reason is empty', () => {
    assert.deepEqual(rulesOf([issue(13, { reason: null })]), ['B-REASON-MISSING app#13'])
  })

  it('emits B-SINCE-STRAY when the reason is none but a day remains', () => {
    assert.deepEqual(rulesOf([issue(14, { since: '2026-10-01' })]), ['B-SINCE-STRAY app#14'])
  })

  it('emits B-BLOCK-STALE when the block-start day is old', () => {
    const item = issue(15, { reason: 'External wait', since: '2026-09-30' })
    assert.deepEqual(rulesOf([item]), ['B-BLOCK-STALE app#15'])
  })

  it('does not call it stale when exactly the limit in days has passed since the block began', () => {
    const item = issue(16, { reason: 'External wait', since: '2026-10-01' })
    assert.deepEqual(rulesOf([item]), [])
  })

  it('does not check issues by excluded authors', () => {
    const item = issue(17, { author: 'external-dev', status: null, reason: null })
    const openIssues = [{ repo: 'example-org/app', number: 18, author: 'external-dev' }]
    assert.deepEqual(rulesOf([item], openIssues), [])
  })

  it('a finding carries a severity and a fix', () => {
    const [finding] = lintBoard(snapshot([issue(5, { status: 'In Progress' })]), config, NOW)
    assert.equal(finding?.severity, 'high')
    assert.equal(finding?.key, 'B-DOING-NO-ASSIGNEE:app#5')
    assert.match(finding?.fix ?? '', /set-assignee 5 /)
  })

  it('when an item has unreadable content, does not emit B-OFF-BOARD since it cannot be judged, and emits one B-UNREADABLE', () => {
    const unreadable = issue(0, { number: null, repo: '' })
    const openIssues = [{ repo: 'example-org/app', number: 42, author: 'owner' }]
    assert.deepEqual(rulesOf([unreadable], openIssues), ['B-UNREADABLE board'])
  })
})

describe('fix and naming configuration', () => {
  it('when no script is configured, returns the fix as a sentence', () => {
    const bare = { ...config, scripts: {} }
    const [finding] = lintBoard(snapshot([issue(7, { state: 'CLOSED', status: 'Release' })]), bare, NOW)
    assert.equal(finding?.fix, 'Set Status to Done')
  })

  it('uses the configured name in the finding about a decision-pending item', () => {
    const named = { ...config, ownerLabel: 'PM' }
    const [finding] = lintBoard(snapshot([issue(11, { reason: 'Needs decision', since: '2026-10-07', owner: 'AI' })]), named, NOW)
    assert.match(finding?.message ?? '', /does not show in PM's view/)
  })
})
