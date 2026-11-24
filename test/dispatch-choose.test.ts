import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chooseNext } from '../src/dispatch/choose.ts'
import { config, issue, pr, snapshot } from './helpers.ts'

const dispatchConfig = {
  ...config,
  dispatch: { enabled: true, baseBranch: 'develop', skipLabels: ['skip-me'], orderField: '順', utcOffset: '+09:00', notes: [] },
}

const next = (number: number, overrides: Parameters<typeof issue>[1] = {}) => issue(number, { status: '次にやる', ...overrides })

function pickedNumber(items: Parameters<typeof snapshot>[0], member = 'SWE1', cfg = dispatchConfig): number | string {
  const result = chooseNext(snapshot(items), member, cfg)
  return result.kind === 'chosen' ? (result.item.number ?? -1) : result.reason
}

describe('chooseNext の区分', () => {
  it('次にやるで担当がその人、バックログで担当がその人、担当なしの次にやる、の順に選ぶ', () => {
    const items = [next(30), issue(20, { assignee: 'SWE1' }), next(10, { assignee: 'SWE1' })]
    assert.equal(pickedNumber(items), 10)
    assert.equal(pickedNumber(items.slice(0, 2)), 20)
    assert.equal(pickedNumber(items.slice(0, 1)), 30)
  })

  it('選んだ区分を結果に残す', () => {
    const result = chooseNext(snapshot([next(30)]), 'SWE1', dispatchConfig)
    assert.deepEqual(result.kind === 'chosen' ? result.tier : null, 3)
  })

  it('担当が別の人のものは渡さない', () => {
    assert.equal(pickedNumber([next(10, { assignee: 'SWE2' }), issue(11, { assignee: 'SWE2' })]), 'no-candidate')
  })

  it('バックログで担当なしのものは渡さない (次にやるだけ)', () => {
    assert.equal(pickedNumber([issue(11)]), 'no-candidate')
  })
})

describe('chooseNext の飛ばすもの', () => {
  it('止まっている理由がなし以外のものは渡さない', () => {
    assert.equal(pickedNumber([next(10, { assignee: 'SWE1', reason: '判断待ち' }), next(11, { reason: null })]), 'no-candidate')
  })

  it('閉じた issue、PR、除くことにした作者の issue は渡さない', () => {
    const items = [next(10, { state: 'CLOSED' }), pr(11, { status: '次にやる', state: 'OPEN' }), next(12, { author: 'external-dev' })]
    assert.equal(pickedNumber(items), 'no-candidate')
  })

  it('渡さない印のラベルが付いたものは渡さない', () => {
    assert.equal(pickedNumber([next(10, { labels: ['skip-me'] }), next(11, { labels: ['別のラベル'] })]), 11)
  })

  it('題が release/<番号> で始まる issue は渡さない (人が手で切り出すリリースの issue。次にやる、バックログ、担当なしのどれでも)', () => {
    const title = 'release/3 の後始末'
    assert.equal(pickedNumber([next(10, { assignee: 'SWE1', title })]), 'no-candidate')
    assert.equal(pickedNumber([issue(11, { assignee: 'SWE1', title: 'release/3 を切る' })]), 'no-candidate')
    assert.equal(pickedNumber([next(12, { title: 'release/12' })]), 'no-candidate')
    assert.equal(pickedNumber([next(10, { assignee: 'SWE1', title }), next(13, { assignee: 'SWE1', title: 'release の手順を直す' })]), 13)
    assert.equal(pickedNumber([next(10, { assignee: 'SWE1', title }), next(14, { title: 'リリースの後の戻し (release/3)' })]), 14)
    assert.equal(pickedNumber([next(10, { assignee: 'SWE1', title }), next(15, { title: 'release/ の入れ方' })]), 15)
  })

  it('既定のリポジトリ以外の issue は渡さない (ボードを書き換えるスクリプトが番号だけで指すため)', () => {
    assert.equal(pickedNumber([next(10, { repo: 'example-org/app-mobile' })]), 'no-candidate')
  })

  it('作業中の上限には、除く作者 (別の開発主体) の作業中も数える (書き込みの守りと同じ数え方)', () => {
    const others = Array.from({ length: config.wipLimit }, (_, index) => issue(100 + index, { status: '作業中', assignee: 'SWE2', author: 'external-dev' }))
    assert.equal(pickedNumber([...others, next(10)]), 'wip-limit')
    assert.equal(pickedNumber([...others.slice(1), next(10)]), 10)
  })

  it('作業中が上限に届いていれば何も渡さない', () => {
    const doing = Array.from({ length: config.wipLimit }, (_, index) => issue(100 + index, { status: '作業中', assignee: 'SWE2' }))
    assert.equal(pickedNumber([...doing, next(10, { assignee: 'SWE1' })]), 'wip-limit')
    assert.equal(pickedNumber([...doing.slice(1), next(10, { assignee: 'SWE1' })]), 10)
  })
})

describe('chooseNext の同じ区分の中の順', () => {
  it('「順」の小さいものを先にし、欄が空のものは最後にする', () => {
    assert.equal(pickedNumber([next(10, { order: 5 }), next(11, { order: 2 }), next(12)]), 11)
    assert.equal(pickedNumber([next(10), next(11, { order: 9 })]), 11)
  })

  it('「順」が同じなら、今動いている人の少ない Epic の子を先にする', () => {
    const busyEpic = [issue(200, { status: '作業中', assignee: 'SWE2', epic: 'app#1' }), issue(201, { status: '作業中', assignee: 'SWE3', epic: 'app#1' })]
    const items = [...busyEpic, next(10, { order: 1, epic: 'app#1' }), next(11, { order: 1, epic: 'app#2' })]
    assert.equal(pickedNumber(items), 11)
  })

  it('それも同じなら、番号の小さいものを先にする', () => {
    assert.equal(pickedNumber([next(12), next(11)]), 11)
  })

  it('区分が違えば、「順」より区分を先にする', () => {
    assert.equal(pickedNumber([next(10, { assignee: 'SWE1', order: 9 }), next(11, { order: 1 })]), 10)
  })
})
