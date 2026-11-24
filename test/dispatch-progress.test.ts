import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths } from '../src/store.ts'
import { activityToken, githubProbe } from '../src/adapters/github/activity.ts'
import { boardOnly, boardToken, cachedProbe, hasProgress, observe, readSeen, seenKey, tokenWith, writeSeen } from '../src/dispatch/progress.ts'
import { issue } from './helpers.ts'

const item = issue(240, { status: 'In Progress', assignee: 'SWE1', reason: 'None', since: '2026-10-08' })

describe('boardToken and hasProgress', () => {
  it('combines Status, blocked reason, assignee, and the block-start day into one marker', () => {
    assert.equal(boardToken(item), 'In Progress|None|SWE1|2026-10-08')
    assert.equal(boardToken(issue(1, { status: null, reason: null, assignee: null, since: null })), '|||')
  })

  it('when the board marker differs, work progressed', () => {
    assert.equal(hasProgress({ board: 'a', github: null }, { board: 'b', github: null }), true)
    assert.equal(hasProgress({ board: 'a', github: null }, { board: 'a', github: null }), false)
  })

  it('the gh marker means progress only when both can be read and they differ; when either cannot be read, compares by the board marker alone', () => {
    assert.equal(hasProgress({ board: 'a', github: 'x' }, { board: 'a', github: 'y' }), true)
    assert.equal(hasProgress({ board: 'a', github: 'x' }, { board: 'a', github: 'x' }), false)
    assert.equal(hasProgress({ board: 'a', github: 'x' }, { board: 'a', github: null }), false)
    assert.equal(hasProgress({ board: 'a', github: null }, { board: 'a', github: 'y' }), false)
  })

  it('does not say progress when there is no marker to compare (a record without a marker)', () => {
    assert.equal(hasProgress(undefined, { board: 'a', github: null }), false)
    assert.equal(hasProgress({ board: 'a', github: null }, undefined), false)
  })

  it('boardOnly does not use gh, and tokenWith adds the gh marker', () => {
    assert.deepEqual(boardOnly(item), { board: 'In Progress|None|SWE1|2026-10-08', github: null })
    assert.deepEqual(tokenWith(() => 'g')(item), { board: 'In Progress|None|SWE1|2026-10-08', github: 'g' })
    assert.deepEqual(tokenWith(() => null)(item).github, null)
  })

  it('tokenWith does not stop when reading the marker throws, and sets the code-host marker to null', () => {
    const throwing = () => {
      throw new Error('cannot read')
    }
    assert.deepEqual(tokenWith(throwing)(item), { board: 'In Progress|None|SWE1|2026-10-08', github: null })
  })
})

describe('activityToken', () => {
  const answer = (issueBody: unknown) => JSON.stringify({ data: { repository: { issue: issueBody } } })

  const pr = (number: number, headRefName: string, title = 't', extra: Record<string, unknown> = {}) => ({ source: { number, state: 'OPEN', headRefOid: `oid${number}`, headRefName, title, ...extra } })

  it('turns the comment count, the head of the linked branch, and the PRs of that branch (number, state, head commit) into a string that does not depend on order', () => {
    const a = answer({
      comments: { totalCount: 3 },
      linkedBranches: { nodes: [{ ref: { name: 'feat/2', target: { oid: 'bbb' } } }, { ref: { name: 'feat/1', target: { oid: 'aaa' } } }] },
      timelineItems: { nodes: [pr(9, 'feat/2'), pr(5, 'feat/1', 't', { state: 'MERGED' }), { source: {} }, {}] },
    })
    assert.equal(activityToken(a, 240), '{"comments":3,"branches":["feat/1@aaa","feat/2@bbb"],"prs":["#5:MERGED@oid5","#9:OPEN@oid9"]}')
  })

  it("when there is a linked branch, uses only PRs from that branch as the marker; does not pick up another person's PRs (even if the title or branch name has the same number)", () => {
    const a = answer({
      comments: { totalCount: 0 },
      linkedBranches: { nodes: [{ ref: { name: 'feat/240', target: { oid: 'aaa' } } }] },
      timelineItems: { nodes: [pr(9, 'feat/240'), pr(10, 'feat/240-other', 'x (#240)'), pr(11, 'docs/other')] },
    })
    assert.deepEqual(JSON.parse(activityToken(a, 240)).prs, ['#9:OPEN@oid9'])
  })

  it("when there is no linked branch, uses as the marker only PRs whose number in the title's parentheses or at the start of the branch name matches the issue", () => {
    const a = answer({
      comments: { totalCount: 0 },
      linkedBranches: { nodes: [] },
      timelineItems: {
        nodes: [pr(1, 'feat/240-ci'), pr(2, 'topic', 'fix: x (#240)'), pr(3, 'topic', 'fix: y (#241\u3001#240)'), pr(4, 'feat/2400-ci'), pr(5, 'topic', 'Fix #240'), pr(6, 'topic', 'z (#2400)'), pr(7, 'feat/guard-240'), pr(8, 'fix/240abc')],
      },
    })
    assert.deepEqual(JSON.parse(activityToken(a, 240)).prs, ['#1:OPEN@oid1', '#2:OPEN@oid2', '#3:OPEN@oid3'])
  })

  it('when there is neither a linked branch nor an issue number, PRs are not included in the marker', () => {
    const a = answer({ comments: { totalCount: 0 }, linkedBranches: { nodes: [] }, timelineItems: { nodes: [pr(1, 'feat/240-ci')] } })
    assert.deepEqual(JSON.parse(activityToken(a)).prs, [])
  })

  it('when the head commit of a PR changes, the marker changes', () => {
    const linked = { nodes: [{ ref: { name: 'feat/240', target: { oid: 'aaa' } } }] }
    const base = { comments: { totalCount: 0 }, linkedBranches: linked, timelineItems: { nodes: [pr(9, 'feat/240')] } }
    const pushed = { ...base, timelineItems: { nodes: [pr(9, 'feat/240', 't', { headRefOid: 'eee' })] } }
    assert.notEqual(activityToken(answer(base), 240), activityToken(answer(pushed), 240))
  })

  it('throws when the issue cannot be read', () => {
    assert.throws(() => activityToken(answer(null)), /cannot read the issue/)
    assert.throws(() => activityToken('broken'))
  })
})

describe('githubProbe', () => {
  it("calls GraphQL once with the item's repository and number; does not call for an item without a number", () => {
    const calls: (readonly string[])[] = []
    const probe = githubProbe((args) => {
      calls.push(args)
      return JSON.stringify({ data: { repository: { issue: { comments: { totalCount: 1 } } } } })
    })
    assert.match(probe(item) ?? '', /"comments":1/)
    assert.ok(calls[0]?.includes('owner=example-org') && calls[0]?.includes('name=app') && calls[0]?.includes('number=240'))
    assert.equal(probe(issue(1, { number: null })), null)
    assert.equal(calls.length, 1)
  })

  it('narrows PRs by the issue number (with no linked branch, only PRs with a matching number go into the marker)', () => {
    const answer = { data: { repository: { issue: { comments: { totalCount: 0 }, linkedBranches: { nodes: [] }, timelineItems: { nodes: [{ source: { number: 7, state: 'OPEN', headRefOid: 'x', headRefName: 'feat/240-ci', title: 't' } }, { source: { number: 8, state: 'OPEN', headRefOid: 'y', headRefName: 'feat/999-ci', title: 't' } }] } } } } }
    assert.deepEqual(JSON.parse(githubProbe(() => JSON.stringify(answer))(item) ?? '{}').prs, ['#7:OPEN@x'])
  })
})

describe('cachedProbe', () => {
  it('reuses the same issue for the ttl and fetches again once it has passed', () => {
    let now = 0
    let calls = 0
    const probe = cachedProbe(() => `v${++calls}`, 1000, () => now)
    assert.equal(probe(item), 'v1')
    now = 999
    assert.equal(probe(item), 'v1')
    now = 1000
    assert.equal(probe(item), 'v2')
    assert.equal(calls, 2)
  })

  it('keeps each issue separately', () => {
    let calls = 0
    const probe = cachedProbe(() => `v${++calls}`, 1000, () => 0)
    assert.deepEqual([probe(item), probe(issue(241)), probe(item)], ['v1', 'v2', 'v1'])
  })

  it('a failure becomes null and is not fetched again meanwhile (even if gh is down, it is not hit every 30 seconds)', () => {
    let calls = 0
    const probe = cachedProbe(() => {
      calls += 1
      throw new Error('gh failed')
    }, 1000, () => 0)
    assert.deepEqual([probe(item), probe(item)], [null, null])
    assert.equal(calls, 1)
  })
})

describe('observe (the marker seen)', () => {
  const at = (minutes: number): Date => new Date(Date.UTC(2026, 10, 3, 15, minutes))
  const token = (github: string | null, board = 'In Progress|None|SWE1|') => ({ board, github })

  it('when seen for the first time, writes the current time', () => {
    assert.deepEqual(observe({}, 'SWE1', 'app#1', token('a'), at(0)), { 'SWE1|app#1': { token: token('a'), at: at(0).toISOString() } })
  })

  it('when the marker progressed, sets the time to now; when not, keeps the earlier time; the marker is replaced with the new one', () => {
    const first = observe({}, 'SWE1', 'app#1', token('a'), at(0))
    const same = observe(first, 'SWE1', 'app#1', token('a'), at(5))
    assert.equal(same['SWE1|app#1']?.at, at(0).toISOString())
    const progressed = observe(same, 'SWE1', 'app#1', token('b'), at(10))
    assert.deepEqual(progressed['SWE1|app#1'], { token: token('b'), at: at(10).toISOString() })
    const boardChanged = observe(progressed, 'SWE1', 'app#1', token('b', 'In Progress|Needs decision|SWE1|'), at(15))
    assert.equal(boardChanged['SWE1|app#1']?.at, at(15).toISOString())
  })

  it('when the gh marker cannot be read (null), does not say progress and keeps the earlier time; the marker is replaced with the new one', () => {
    const first = observe({}, 'SWE1', 'app#1', token('a'), at(0))
    const unreadable = observe(first, 'SWE1', 'app#1', token(null), at(5))
    assert.deepEqual(unreadable['SWE1|app#1'], { token: token(null), at: at(0).toISOString() })
  })

  it('drops entries for other issues of the same member; keeps entries of other members', () => {
    const seen = { ...observe({}, 'SWE1', 'app#1', token('a'), at(0)), ...observe({}, 'SWE2', 'app#1', token('x'), at(0)) }
    const next = observe(seen, 'SWE1', 'app#2', token('c'), at(5))
    assert.deepEqual(Object.keys(next).toSorted(), ['SWE1|app#2', 'SWE2|app#1'])
    assert.equal(seenKey('SWE1', 'app#2'), 'SWE1|app#2')
  })
})

describe('readSeen and writeSeen', () => {
  it('reads back what was written; empty when nothing exists', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-seen-')))
    assert.deepEqual(readSeen(p), {})
    const seen = observe({}, 'SWE1', 'app#1', { board: 'b', github: null }, new Date(Date.UTC(2026, 10, 3, 15, 0)))
    writeSeen(p, seen)
    assert.deepEqual(readSeen(p), seen)
  })

  it('broken content is empty; entries of the wrong shape (no marker, unreadable time, an array) are dropped', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-seen-')))
    const write = (value: unknown) => {
      writeSeen(p, value as never)
    }
    write([1, 2])
    assert.deepEqual(readSeen(p), {})
    write([{ token: { board: 'b', github: null }, at: '2026-11-03T15:00:00.000Z' }])
    assert.deepEqual(readSeen(p), {})
    write({ ok: { token: { board: 'b', github: 'g' }, at: '2026-11-03T15:00:00.000Z' }, noToken: { at: '2026-11-03T15:00:00.000Z' }, badAt: { token: { board: 'b', github: null }, at: 'x' }, badGithub: { token: { board: 'b', github: 1 }, at: '2026-11-03T15:00:00.000Z' } })
    assert.deepEqual(Object.keys(readSeen(p)), ['ok'])
    writeFileSync(p.dispatchSeen, '{ broken')
    assert.deepEqual(readSeen(p), {})
  })
})
