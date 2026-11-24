import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchIssueComments } from '../src/adapters/github/issues.ts'
import { overrunBasis, parseOverrunMark, type IssueComment } from '../src/sprint/overrun-mark.ts'

const mark = (decision: string, from: number, to: number) => `<!-- scrum:points-overrun decision=${decision} from=${from} to=${to} -->`
const OVER_SINCE = '2026-10-30T08:00:00+09:00'
const comment = (body: string, createdAt: string, url?: string): IssueComment => ({ body, createdAt, ...(url === undefined ? {} : { url }) })
const AFTER = '2026-10-30T09:00:00+09:00'
const BEFORE = '2026-10-30T07:00:00+09:00'

describe('parseOverrunMark', () => {
  it('1 行目の印から、決めと前後のポイントを読む。4 つの決めすべて', () => {
    assert.deepEqual(parseOverrunMark(mark('reestimate', 3, 5)), { decision: 'reestimate', from: 3, to: 5 })
    assert.deepEqual(parseOverrunMark(mark('split', 3, 3)), { decision: 'split', from: 3, to: 3 })
    assert.deepEqual(parseOverrunMark(mark('add-hands', 2, 2)), { decision: 'add-hands', from: 2, to: 2 })
    assert.deepEqual(parseOverrunMark(mark('keep', 2, 2)), { decision: 'keep', from: 2, to: 2 })
  })

  it('印の後ろに、人が読む文が続いてもよい (CRLF でも)', () => {
    assert.deepEqual(parseOverrunMark(`${mark('keep', 2, 2)}\nTechLead: waiting out the overrun`), { decision: 'keep', from: 2, to: 2 })
    assert.deepEqual(parseOverrunMark(`${mark('keep', 2, 2)}\r\nText`), { decision: 'keep', from: 2, to: 2 })
  })

  it('1 行目でなければ、印として読まない (文の途中や、2 行目の印)', () => {
    assert.equal(parseOverrunMark(`Text\n${mark('keep', 2, 2)}`), null)
    assert.equal(parseOverrunMark(`Text ${mark('keep', 2, 2)}`), null)
  })

  it('印の行の末尾に文字があるものと、先頭に空行があるものは、印として読まない', () => {
    assert.equal(parseOverrunMark(`${mark('keep', 2, 2)} appended`), null)
    assert.equal(parseOverrunMark(`${mark('keep', 2, 2)}-->`), null)
    assert.equal(parseOverrunMark(`\n${mark('keep', 2, 2)}`), null)
    assert.equal(parseOverrunMark(`\n\n${mark('keep', 2, 2)}\nText`), null)
  })

  it('決めが 4 つのどれでもない、欄が欠けた、数が整数でない印は、null', () => {
    assert.equal(parseOverrunMark(mark('ignore', 2, 2)), null)
    assert.equal(parseOverrunMark('<!-- scrum:points-overrun decision=keep from=2 -->'), null)
    assert.equal(parseOverrunMark('<!-- scrum:points-overrun decision=keep from=2.5 to=2.5 -->'), null)
    assert.equal(parseOverrunMark('<!-- scrum:other decision=keep from=2 to=2 -->'), null)
    assert.equal(parseOverrunMark(''), null)
  })
})

describe('overrunBasis', () => {
  it('超過を出した節目より後の、正しい印があれば、その印を根拠にする (コメントの URL も残す)', () => {
    const result = overrunBasis([comment(mark('reestimate', 3, 5), AFTER, 'https://example.invalid/c/1')], OVER_SINCE, 5)
    assert.deepEqual(result, { ok: true, basis: 'decision=reestimate from=3 to=5 (https://example.invalid/c/1)' })
  })

  it('超過を出した節目より前の印は、使わない (前の見直しで、いまの超過を消さない)', () => {
    const result = overrunBasis([comment(mark('keep', 2, 2), BEFORE)], OVER_SINCE, 2)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /the issue has no mark for handling the overrun/)
  })

  it('節目とちょうど同じ時刻の印も、使わない (「より後」)', () => {
    assert.equal(overrunBasis([comment(mark('keep', 2, 2), OVER_SINCE)], OVER_SINCE, 2).ok, false)
  })

  it('印の無いコメントだけなら、受け入れない。メッセージに、印の書き方を出す', () => {
    const result = overrunBasis([comment('Revised the estimate', AFTER)], OVER_SINCE, 5)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /<!-- scrum:points-overrun decision=<reestimate\|split\|add-hands\|keep>/)
  })

  it('keep は、from と to が同じでなければ、受け入れない', () => {
    const result = overrunBasis([comment(mark('keep', 2, 3), AFTER)], OVER_SINCE, 3)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /keep leaves the estimate as it is/)
  })

  it('reestimate は、from と to が違わなければ、受け入れない', () => {
    const result = overrunBasis([comment(mark('reestimate', 3, 3), AFTER)], OVER_SINCE, 3)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /reestimate changes the estimate/)
  })

  it('reestimate は、to がボードのポイントと同じでなければ、受け入れない (印だけで、ボードを直していない)', () => {
    const result = overrunBasis([comment(mark('reestimate', 3, 5), AFTER)], OVER_SINCE, 3)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /to=5 differs from the points on the board \(3\)/)
    const noPoints = overrunBasis([comment(mark('reestimate', 3, 5), AFTER)], OVER_SINCE, null)
    assert.equal(noPoints.ok, false)
    assert.match(noPoints.ok ? '' : noPoints.message, /differs from the points on the board \(none\)/)
    assert.equal(overrunBasis([comment(mark('reestimate', 3, 5), AFTER)], OVER_SINCE, 5).ok, true)
  })

  it('split と add-hands は、from と to の関係を問わない (ボードのポイントも問わない)', () => {
    assert.equal(overrunBasis([comment(mark('split', 3, 3), AFTER)], OVER_SINCE, 8).ok, true)
    assert.equal(overrunBasis([comment(mark('add-hands', 3, 5), AFTER)], OVER_SINCE, 3).ok, true)
  })

  it('正しくない新しい印と、正しい古い印があれば、正しい印を使う。新しいほうが正しければ、新しいほうを使う', () => {
    const older = comment(mark('keep', 2, 2), '2026-10-30T09:00:00+09:00', 'old')
    const newer = comment(mark('keep', 2, 3), '2026-10-30T10:00:00+09:00', 'new')
    const useOlder = overrunBasis([older, newer], OVER_SINCE, 2)
    assert.equal(useOlder.ok, true)
    assert.match(useOlder.ok ? useOlder.basis : '', /old/)
    const newerValid = comment(mark('split', 2, 2), '2026-10-30T10:00:00+09:00', 'new')
    const useNewer = overrunBasis([older, newerValid], OVER_SINCE, 2)
    assert.equal(useNewer.ok, true)
    assert.match(useNewer.ok ? useNewer.basis : '', /new/)
  })
})

describe('fetchIssueComments', () => {
  it('gh issue view の JSON から、本文と時刻と URL を取り出し、欠けたコメントは飛ばす', () => {
    const calls: (readonly string[])[] = []
    const run = (args: readonly string[]) => {
      calls.push(args)
      return JSON.stringify({ comments: [{ body: 'a', createdAt: '2026-10-30T00:00:00Z', url: 'u1' }, { body: 'b' }, { createdAt: 'x' }, { body: 'c', createdAt: '2026-10-30T01:00:00Z' }] })
    }
    assert.deepEqual(fetchIssueComments('example-org/app', 7, run), [
      { body: 'a', createdAt: '2026-10-30T00:00:00Z', url: 'u1' },
      { body: 'c', createdAt: '2026-10-30T01:00:00Z' },
    ])
    assert.deepEqual(calls[0], ['issue', 'view', '7', '-R', 'example-org/app', '--json', 'comments'])
  })

  it('comments が無い結果は、空にする', () => {
    assert.deepEqual(fetchIssueComments('example-org/app', 7, () => '{}'), [])
  })
})
