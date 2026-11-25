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
  it('reads the decision and the before and after points from the marker on line 1; all 4 decisions', () => {
    assert.deepEqual(parseOverrunMark(mark('reestimate', 3, 5)), { decision: 'reestimate', from: 3, to: 5 })
    assert.deepEqual(parseOverrunMark(mark('split', 3, 3)), { decision: 'split', from: 3, to: 3 })
    assert.deepEqual(parseOverrunMark(mark('add-hands', 2, 2)), { decision: 'add-hands', from: 2, to: 2 })
    assert.deepEqual(parseOverrunMark(mark('keep', 2, 2)), { decision: 'keep', from: 2, to: 2 })
  })

  it('human-readable text may follow the marker (even with CRLF)', () => {
    assert.deepEqual(parseOverrunMark(`${mark('keep', 2, 2)}\nTechLead: waiting out the overrun`), { decision: 'keep', from: 2, to: 2 })
    assert.deepEqual(parseOverrunMark(`${mark('keep', 2, 2)}\r\nText`), { decision: 'keep', from: 2, to: 2 })
  })

  it('does not read it as a marker unless it is on line 1 (in the middle of a sentence, or a marker on line 2)', () => {
    assert.equal(parseOverrunMark(`Text\n${mark('keep', 2, 2)}`), null)
    assert.equal(parseOverrunMark(`Text ${mark('keep', 2, 2)}`), null)
  })

  it('does not read as a marker a line with trailing characters after the marker, or a body with a blank line before it', () => {
    assert.equal(parseOverrunMark(`${mark('keep', 2, 2)} appended`), null)
    assert.equal(parseOverrunMark(`${mark('keep', 2, 2)}-->`), null)
    assert.equal(parseOverrunMark(`\n${mark('keep', 2, 2)}`), null)
    assert.equal(parseOverrunMark(`\n\n${mark('keep', 2, 2)}\nText`), null)
  })

  it('null for a marker whose decision is none of the 4, with a missing field, or with a non-integer number', () => {
    assert.equal(parseOverrunMark(mark('ignore', 2, 2)), null)
    assert.equal(parseOverrunMark('<!-- scrum:points-overrun decision=keep from=2 -->'), null)
    assert.equal(parseOverrunMark('<!-- scrum:points-overrun decision=keep from=2.5 to=2.5 -->'), null)
    assert.equal(parseOverrunMark('<!-- scrum:other decision=keep from=2 to=2 -->'), null)
    assert.equal(parseOverrunMark(''), null)
  })
})

describe('overrunBasis', () => {
  it('when a valid marker later than the checkpoint that reported the overrun exists, takes it as the basis (keeps the comment URL too)', () => {
    const result = overrunBasis([comment(mark('reestimate', 3, 5), AFTER, 'https://example.invalid/c/1')], OVER_SINCE, 5)
    assert.deepEqual(result, { ok: true, basis: 'decision=reestimate from=3 to=5 (https://example.invalid/c/1)' })
  })

  it('does not use a marker earlier than the checkpoint that reported the overrun (an earlier review does not clear the current overrun)', () => {
    const result = overrunBasis([comment(mark('keep', 2, 2), BEFORE)], OVER_SINCE, 2)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /the issue has no mark for handling the overrun/)
  })

  it('does not use a marker at exactly the same time as the checkpoint (it must be later)', () => {
    assert.equal(overrunBasis([comment(mark('keep', 2, 2), OVER_SINCE)], OVER_SINCE, 2).ok, false)
  })

  it('does not accept comments that have no marker; shows how to write the marker in the message', () => {
    const result = overrunBasis([comment('Revised the estimate', AFTER)], OVER_SINCE, 5)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /<!-- scrum:points-overrun decision=<reestimate\|split\|add-hands\|keep>/)
  })

  it('does not accept keep unless from and to are equal', () => {
    const result = overrunBasis([comment(mark('keep', 2, 3), AFTER)], OVER_SINCE, 3)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /keep leaves the estimate as it is/)
  })

  it('does not accept reestimate unless from and to differ', () => {
    const result = overrunBasis([comment(mark('reestimate', 3, 3), AFTER)], OVER_SINCE, 3)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /reestimate changes the estimate/)
  })

  it("does not accept reestimate unless to equals the board's points (a marker alone, with the board not fixed)", () => {
    const result = overrunBasis([comment(mark('reestimate', 3, 5), AFTER)], OVER_SINCE, 3)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /to=5 differs from the points on the board \(3\)/)
    const noPoints = overrunBasis([comment(mark('reestimate', 3, 5), AFTER)], OVER_SINCE, null)
    assert.equal(noPoints.ok, false)
    assert.match(noPoints.ok ? '' : noPoints.message, /differs from the points on the board \(none\)/)
    assert.equal(overrunBasis([comment(mark('reestimate', 3, 5), AFTER)], OVER_SINCE, 5).ok, true)
  })

  it("split and add-hands do not care about the relation between from and to (nor about the board's points)", () => {
    assert.equal(overrunBasis([comment(mark('split', 3, 3), AFTER)], OVER_SINCE, 8).ok, true)
    assert.equal(overrunBasis([comment(mark('add-hands', 3, 5), AFTER)], OVER_SINCE, 3).ok, true)
  })

  it('when there is an invalid newer marker and a valid older one, uses the valid one; when the newer one is valid, uses the newer one', () => {
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
  it('extracts the body, time, and URL from the JSON of gh issue view, and skips a comment with missing parts', () => {
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

  it('a result without comments becomes empty', () => {
    assert.deepEqual(fetchIssueComments('example-org/app', 7, () => '{}'), [])
  })
})
