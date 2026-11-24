import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lintBoard } from '../src/board/rules.ts'
import { config, issue, NOW, pr, snapshot } from './helpers.ts'

function rulesOf(items: Parameters<typeof snapshot>[0], openIssues?: Parameters<typeof snapshot>[1]) {
  return lintBoard(snapshot(items, openIssues), config, NOW).map((f) => `${f.rule} ${f.subject}`)
}

describe('lintBoard', () => {
  it('作業中が上限を超えると B-WIP-OVER を出す', () => {
    const doing = Array.from({ length: 11 }, (_, i) => issue(i + 1, { status: '作業中', assignee: 'SWE1' }))
    assert.deepEqual(rulesOf(doing), ['B-WIP-OVER board'])
  })

  it('作業中がちょうど上限なら何も出さない', () => {
    const doing = Array.from({ length: 10 }, (_, i) => issue(i + 1, { status: '作業中', assignee: 'SWE1' }))
    assert.deepEqual(rulesOf(doing), [])
  })

  it('閉じた issue の作業中は上限に数えない', () => {
    const doing = Array.from({ length: 10 }, (_, i) => issue(i + 1, { status: '作業中', assignee: 'SWE1' }))
    const closed = issue(99, { status: '作業中', state: 'CLOSED', assignee: 'SWE1' })
    assert.deepEqual(rulesOf([...doing, closed]), ['B-CLOSED-NOT-DONE app#99'])
  })

  it('作業中に担当が無いと B-DOING-NO-ASSIGNEE を出す', () => {
    assert.deepEqual(rulesOf([issue(5, { status: '作業中' })]), ['B-DOING-NO-ASSIGNEE app#5'])
  })

  it('閉じた issue が完了でないと B-CLOSED-NOT-DONE を出す', () => {
    assert.deepEqual(rulesOf([issue(7, { state: 'CLOSED', status: 'リリース待ち' })]), ['B-CLOSED-NOT-DONE app#7'])
  })

  it('開いた issue が完了なら B-OPEN-DONE を出す', () => {
    assert.deepEqual(rulesOf([issue(8, { status: '完了' })]), ['B-OPEN-DONE app#8'])
  })

  it('PR に Status があると B-PR-STATUS を出す', () => {
    assert.deepEqual(rulesOf([pr(102, { status: '作業中' })]), ['B-PR-STATUS app#102'])
  })

  it('Status の無い PR は何も出さない', () => {
    assert.deepEqual(rulesOf([pr(103)]), [])
  })

  it('開いた issue に Status が無いと B-NO-STATUS を出す', () => {
    assert.deepEqual(rulesOf([issue(9, { status: null })]), ['B-NO-STATUS app#9'])
  })

  it('開いた issue がボードに無いと B-OFF-BOARD を出す', () => {
    const openIssues = [{ repo: 'example-org/app', number: 42, author: 'owner' }]
    assert.deepEqual(rulesOf([], openIssues), ['B-OFF-BOARD app#42'])
  })

  it('次にやるが止まっていると B-NEXT-BLOCKED を出す', () => {
    const item = issue(10, { status: '次にやる', reason: '外部待ち', since: '2026-10-07' })
    assert.deepEqual(rulesOf([item]), ['B-NEXT-BLOCKED app#10'])
  })

  it('判断待ちの Owner がオーナーでないと B-JUDGE-OWNER を出す', () => {
    const item = issue(11, { reason: '判断待ち', since: '2026-10-07', owner: 'AI' })
    assert.deepEqual(rulesOf([item]), ['B-JUDGE-OWNER app#11'])
  })

  it('止まっているのに止まり始めた日が無いと B-SINCE-MISSING を出す', () => {
    assert.deepEqual(rulesOf([issue(12, { reason: '外部待ち' })]), ['B-SINCE-MISSING app#12'])
  })

  it('止まっている理由が空だと B-REASON-MISSING を出す', () => {
    assert.deepEqual(rulesOf([issue(13, { reason: null })]), ['B-REASON-MISSING app#13'])
  })

  it('理由がなしなのに日が残っていると B-SINCE-STRAY を出す', () => {
    assert.deepEqual(rulesOf([issue(14, { since: '2026-10-01' })]), ['B-SINCE-STRAY app#14'])
  })

  it('止まり始めた日が古いと B-BLOCK-STALE を出す', () => {
    const item = issue(15, { reason: '外部待ち', since: '2026-09-30' })
    assert.deepEqual(rulesOf([item]), ['B-BLOCK-STALE app#15'])
  })

  it('止まり始めて上限の日数ちょうどなら古いとしない', () => {
    const item = issue(16, { reason: '外部待ち', since: '2026-10-01' })
    assert.deepEqual(rulesOf([item]), [])
  })

  it('対象外の作者の issue は検査しない', () => {
    const item = issue(17, { author: 'external-dev', status: null, reason: null })
    const openIssues = [{ repo: 'example-org/app', number: 18, author: 'external-dev' }]
    assert.deepEqual(rulesOf([item], openIssues), [])
  })

  it('指摘に重さと直し方が付く', () => {
    const [finding] = lintBoard(snapshot([issue(5, { status: '作業中' })]), config, NOW)
    assert.equal(finding?.severity, 'high')
    assert.equal(finding?.key, 'B-DOING-NO-ASSIGNEE:app#5')
    assert.match(finding?.fix ?? '', /set-assignee 5 /)
  })

  it('中身の読めない項目があれば、B-OFF-BOARD は判じられないので出さず、B-UNREADABLE を1件出す', () => {
    const unreadable = issue(0, { number: null, repo: '' })
    const openIssues = [{ repo: 'example-org/app', number: 42, author: 'owner' }]
    assert.deepEqual(rulesOf([unreadable], openIssues), ['B-UNREADABLE board'])
  })
})

describe('直し方と呼び方の設定', () => {
  it('スクリプトを設定していなければ、直し方を文で返す', () => {
    const bare = { ...config, scripts: {} }
    const [finding] = lintBoard(snapshot([issue(7, { state: 'CLOSED', status: 'リリース待ち' })]), bare, NOW)
    assert.equal(finding?.fix, 'Status を 完了 にする')
  })

  it('判断待ちの指摘に、設定の呼び方を使う', () => {
    const named = { ...config, ownerLabel: 'PM' }
    const [finding] = lintBoard(snapshot([issue(11, { reason: '判断待ち', since: '2026-10-07', owner: 'AI' })]), named, NOW)
    assert.match(finding?.message ?? '', /PM のビューに出ない/)
  })
})
