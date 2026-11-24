import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chooseNext } from '../src/dispatch/choose.ts'
import { config, issue, pr, snapshot } from './helpers.ts'

const dispatchConfig = {
  ...config,
  dispatch: { enabled: true, baseBranch: 'develop', skipLabels: ['skip-me'], orderField: 'Order', utcOffset: '+09:00', notes: [] },
}

const next = (number: number, overrides: Parameters<typeof issue>[1] = {}) => issue(number, { status: 'Next', ...overrides })

function pickedNumber(items: Parameters<typeof snapshot>[0], member = 'SWE1', cfg = dispatchConfig): number | string {
  const result = chooseNext(snapshot(items), member, cfg)
  return result.kind === 'chosen' ? (result.item.number ?? -1) : result.reason
}

describe('chooseNext categories', () => {
  it('chooses in this order: Next assigned to that person, Backlog assigned to that person, unassigned Next', () => {
    const items = [next(30), issue(20, { assignee: 'SWE1' }), next(10, { assignee: 'SWE1' })]
    assert.equal(pickedNumber(items), 10)
    assert.equal(pickedNumber(items.slice(0, 2)), 20)
    assert.equal(pickedNumber(items.slice(0, 1)), 30)
  })

  it('keeps the chosen category in the result', () => {
    const result = chooseNext(snapshot([next(30)]), 'SWE1', dispatchConfig)
    assert.deepEqual(result.kind === 'chosen' ? result.tier : null, 3)
  })

  it('does not hand over an item assigned to someone else', () => {
    assert.equal(pickedNumber([next(10, { assignee: 'SWE2' }), issue(11, { assignee: 'SWE2' })]), 'no-candidate')
  })

  it('does not hand over an unassigned Backlog item (only Next)', () => {
    assert.equal(pickedNumber([issue(11)]), 'no-candidate')
  })
})

describe('what chooseNext skips', () => {
  it('does not hand over an item whose blocked reason is anything other than none', () => {
    assert.equal(pickedNumber([next(10, { assignee: 'SWE1', reason: 'Needs decision' }), next(11, { reason: null })]), 'no-candidate')
  })

  it('does not hand over a closed issue, a PR, or an issue by an excluded author', () => {
    const items = [next(10, { state: 'CLOSED' }), pr(11, { status: 'Next', state: 'OPEN' }), next(12, { author: 'external-dev' })]
    assert.equal(pickedNumber(items), 'no-candidate')
  })

  it('does not hand over an item that carries a do-not-hand-over marker label', () => {
    assert.equal(pickedNumber([next(10, { labels: ['skip-me'] }), next(11, { labels: ['another-label'] })]), 11)
  })

  it('does not hand over an issue whose title starts with release/<number> (a release issue a person cuts by hand; whether it is in Next, Backlog, or unassigned)', () => {
    const title = 'release/3 cleanup'
    assert.equal(pickedNumber([next(10, { assignee: 'SWE1', title })]), 'no-candidate')
    assert.equal(pickedNumber([issue(11, { assignee: 'SWE1', title: 'release/3 cut' })]), 'no-candidate')
    assert.equal(pickedNumber([next(12, { title: 'release/12' })]), 'no-candidate')
    assert.equal(pickedNumber([next(10, { assignee: 'SWE1', title }), next(13, { assignee: 'SWE1', title: 'release steps fix' })]), 13)
    assert.equal(pickedNumber([next(10, { assignee: 'SWE1', title }), next(14, { title: 'Rollback after the release (release/3)' })]), 14)
    assert.equal(pickedNumber([next(10, { assignee: 'SWE1', title }), next(15, { title: 'release/ usage' })]), 15)
  })

  it('does not hand over an issue outside the default repository (because the script that rewrites the board points at an issue by number alone)', () => {
    assert.equal(pickedNumber([next(10, { repo: 'example-org/app-mobile' })]), 'no-candidate')
  })

  it('the In Progress limit also counts the In Progress of excluded authors (another development agent), the same way the write guard counts', () => {
    const others = Array.from({ length: config.wipLimit }, (_, index) => issue(100 + index, { status: 'In Progress', assignee: 'SWE2', author: 'external-dev' }))
    assert.equal(pickedNumber([...others, next(10)]), 'wip-limit')
    assert.equal(pickedNumber([...others.slice(1), next(10)]), 10)
  })

  it('hands over nothing when In Progress has reached the limit', () => {
    const doing = Array.from({ length: config.wipLimit }, (_, index) => issue(100 + index, { status: 'In Progress', assignee: 'SWE2' }))
    assert.equal(pickedNumber([...doing, next(10, { assignee: 'SWE1' })]), 'wip-limit')
    assert.equal(pickedNumber([...doing.slice(1), next(10, { assignee: 'SWE1' })]), 10)
  })
})

describe('order within the same category of chooseNext', () => {
  it('puts the smaller "order" first and an empty field last', () => {
    assert.equal(pickedNumber([next(10, { order: 5 }), next(11, { order: 2 }), next(12)]), 11)
    assert.equal(pickedNumber([next(10), next(11, { order: 9 })]), 11)
  })

  it('when "order" ties, puts first the children of the Epic with fewer people currently moving', () => {
    const busyEpic = [issue(200, { status: 'In Progress', assignee: 'SWE2', epic: 'app#1' }), issue(201, { status: 'In Progress', assignee: 'SWE3', epic: 'app#1' })]
    const items = [...busyEpic, next(10, { order: 1, epic: 'app#1' }), next(11, { order: 1, epic: 'app#2' })]
    assert.equal(pickedNumber(items), 11)
  })

  it('when that ties too, puts the smaller number first', () => {
    assert.equal(pickedNumber([next(12), next(11)]), 11)
  })

  it('when the category differs, the category comes before "order"', () => {
    assert.equal(pickedNumber([next(10, { assignee: 'SWE1', order: 9 }), next(11, { order: 1 })]), 10)
  })
})
