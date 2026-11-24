import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths } from '../src/store.ts'
import { activityToken, githubProbe } from '../src/adapters/github/activity.ts'
import { boardOnly, boardToken, cachedProbe, hasProgress, observe, readSeen, seenKey, tokenWith, writeSeen } from '../src/dispatch/progress.ts'
import { issue } from './helpers.ts'

const item = issue(240, { status: '作業中', assignee: 'SWE1', reason: 'なし', since: '2026-10-08' })

describe('boardToken と hasProgress', () => {
  it('Status、止まっている理由、担当、止まり始めた日を 1 つの印にする', () => {
    assert.equal(boardToken(item), '作業中|なし|SWE1|2026-10-08')
    assert.equal(boardToken(issue(1, { status: null, reason: null, assignee: null, since: null })), '|||')
  })

  it('ボードの印が違えば、作業が進んだ', () => {
    assert.equal(hasProgress({ board: 'a', github: null }, { board: 'b', github: null }), true)
    assert.equal(hasProgress({ board: 'a', github: null }, { board: 'a', github: null }), false)
  })

  it('gh の印は、両方が読めていて、違うときだけ、作業が進んだ。どちらかが読めなければ、ボードの印だけで比べる', () => {
    assert.equal(hasProgress({ board: 'a', github: 'x' }, { board: 'a', github: 'y' }), true)
    assert.equal(hasProgress({ board: 'a', github: 'x' }, { board: 'a', github: 'x' }), false)
    assert.equal(hasProgress({ board: 'a', github: 'x' }, { board: 'a', github: null }), false)
    assert.equal(hasProgress({ board: 'a', github: null }, { board: 'a', github: 'y' }), false)
  })

  it('比べる印が無い (記録が古い形) ときは、進んだと言わない', () => {
    assert.equal(hasProgress(undefined, { board: 'a', github: null }), false)
    assert.equal(hasProgress({ board: 'a', github: null }, undefined), false)
  })

  it('boardOnly は gh を使わず、tokenWith は gh の印を足す', () => {
    assert.deepEqual(boardOnly(item), { board: '作業中|なし|SWE1|2026-10-08', github: null })
    assert.deepEqual(tokenWith(() => 'g')(item), { board: '作業中|なし|SWE1|2026-10-08', github: 'g' })
    assert.deepEqual(tokenWith(() => null)(item).github, null)
  })

  it('tokenWith は、印の読み取りが投げても止まらず、コードの置き場の印を null にする', () => {
    const throwing = () => {
      throw new Error('読めない')
    }
    assert.deepEqual(tokenWith(throwing)(item), { board: '作業中|なし|SWE1|2026-10-08', github: null })
  })
})

describe('activityToken', () => {
  const answer = (issueBody: unknown) => JSON.stringify({ data: { repository: { issue: issueBody } } })

  const pr = (number: number, headRefName: string, title = 't', extra: Record<string, unknown> = {}) => ({ source: { number, state: 'OPEN', headRefOid: `oid${number}`, headRefName, title, ...extra } })

  it('コメントの数、紐づいたブランチの先頭、そのブランチの PR (番号、状態、先頭のコミット) を、並び順によらない文字列にする', () => {
    const a = answer({
      comments: { totalCount: 3 },
      linkedBranches: { nodes: [{ ref: { name: 'feat/2', target: { oid: 'bbb' } } }, { ref: { name: 'feat/1', target: { oid: 'aaa' } } }] },
      timelineItems: { nodes: [pr(9, 'feat/2'), pr(5, 'feat/1', 't', { state: 'MERGED' }), { source: {} }, {}] },
    })
    assert.equal(activityToken(a, 240), '{"comments":3,"branches":["feat/1@aaa","feat/2@bbb"],"prs":["#5:MERGED@oid5","#9:OPEN@oid9"]}')
  })

  it('紐づいたブランチがあれば、そのブランチから出た PR だけを印にする。ほかの人の PR (題やブランチ名が同じ番号でも) は拾わない', () => {
    const a = answer({
      comments: { totalCount: 0 },
      linkedBranches: { nodes: [{ ref: { name: 'feat/240', target: { oid: 'aaa' } } }] },
      timelineItems: { nodes: [pr(9, 'feat/240'), pr(10, 'feat/240-other', 'x (#240)'), pr(11, 'docs/other')] },
    })
    assert.deepEqual(JSON.parse(activityToken(a, 240)).prs, ['#9:OPEN@oid9'])
  })

  it('紐づいたブランチが無ければ、題の括弧の中か、ブランチ名の先頭の番号が、その issue と合う PR だけを印にする', () => {
    const a = answer({
      comments: { totalCount: 0 },
      linkedBranches: { nodes: [] },
      timelineItems: {
        nodes: [pr(1, 'feat/240-ci'), pr(2, 'topic', 'fix: x (#240)'), pr(3, 'topic', 'fix: y (#241、#240)'), pr(4, 'feat/2400-ci'), pr(5, 'topic', '#240 を直す'), pr(6, 'topic', 'z (#2400)'), pr(7, 'feat/guard-240'), pr(8, 'fix/240abc')],
      },
    })
    assert.deepEqual(JSON.parse(activityToken(a, 240)).prs, ['#1:OPEN@oid1', '#2:OPEN@oid2', '#3:OPEN@oid3'])
  })

  it('紐づいたブランチも、issue の番号も無ければ、PR は印に入れない', () => {
    const a = answer({ comments: { totalCount: 0 }, linkedBranches: { nodes: [] }, timelineItems: { nodes: [pr(1, 'feat/240-ci')] } })
    assert.deepEqual(JSON.parse(activityToken(a)).prs, [])
  })

  it('PR の先頭のコミットが変われば、印が変わる', () => {
    const linked = { nodes: [{ ref: { name: 'feat/240', target: { oid: 'aaa' } } }] }
    const base = { comments: { totalCount: 0 }, linkedBranches: linked, timelineItems: { nodes: [pr(9, 'feat/240')] } }
    const pushed = { ...base, timelineItems: { nodes: [pr(9, 'feat/240', 't', { headRefOid: 'eee' })] } }
    assert.notEqual(activityToken(answer(base), 240), activityToken(answer(pushed), 240))
  })

  it('issue が読めなければ投げる', () => {
    assert.throws(() => activityToken(answer(null)), /issue を読めない/)
    assert.throws(() => activityToken('壊れた'))
  })
})

describe('githubProbe', () => {
  it('項目のリポジトリと番号で、GraphQL を 1 回呼ぶ。番号の無い項目は呼ばない', () => {
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

  it('issue の番号で PR を絞る (紐づいたブランチが無ければ、番号の合う PR だけを印に入れる)', () => {
    const answer = { data: { repository: { issue: { comments: { totalCount: 0 }, linkedBranches: { nodes: [] }, timelineItems: { nodes: [{ source: { number: 7, state: 'OPEN', headRefOid: 'x', headRefName: 'feat/240-ci', title: 't' } }, { source: { number: 8, state: 'OPEN', headRefOid: 'y', headRefName: 'feat/999-ci', title: 't' } }] } } } } }
    assert.deepEqual(JSON.parse(githubProbe(() => JSON.stringify(answer))(item) ?? '{}').prs, ['#7:OPEN@x'])
  })
})

describe('cachedProbe', () => {
  it('同じ issue は ttl の間、使い回し、過ぎたら取り直す', () => {
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

  it('issue ごとに別に持つ', () => {
    let calls = 0
    const probe = cachedProbe(() => `v${++calls}`, 1000, () => 0)
    assert.deepEqual([probe(item), probe(issue(241)), probe(item)], ['v1', 'v2', 'v1'])
  })

  it('失敗は null にして、その間は取り直さない (gh が落ちていても、30 秒ごとに叩かない)', () => {
    let calls = 0
    const probe = cachedProbe(() => {
      calls += 1
      throw new Error('gh が失敗')
    }, 1000, () => 0)
    assert.deepEqual([probe(item), probe(item)], [null, null])
    assert.equal(calls, 1)
  })
})

describe('observe (見た印)', () => {
  const at = (minutes: number): Date => new Date(Date.UTC(2026, 10, 3, 15, minutes))
  const token = (github: string | null, board = '作業中|なし|SWE1|') => ({ board, github })

  it('初めて見たときは、いまの時刻を書く', () => {
    assert.deepEqual(observe({}, 'SWE1', 'app#1', token('a'), at(0)), { 'SWE1|app#1': { token: token('a'), at: at(0).toISOString() } })
  })

  it('印が進んでいれば時刻を今にし、進んでいなければ前の時刻のまま。印は新しいものに替える', () => {
    const first = observe({}, 'SWE1', 'app#1', token('a'), at(0))
    const same = observe(first, 'SWE1', 'app#1', token('a'), at(5))
    assert.equal(same['SWE1|app#1']?.at, at(0).toISOString())
    const progressed = observe(same, 'SWE1', 'app#1', token('b'), at(10))
    assert.deepEqual(progressed['SWE1|app#1'], { token: token('b'), at: at(10).toISOString() })
    const boardChanged = observe(progressed, 'SWE1', 'app#1', token('b', '作業中|判断待ち|SWE1|'), at(15))
    assert.equal(boardChanged['SWE1|app#1']?.at, at(15).toISOString())
  })

  it('gh の印が読めないとき (null) は、進んだと言わず、時刻は前のまま。印は新しいものに替える', () => {
    const first = observe({}, 'SWE1', 'app#1', token('a'), at(0))
    const unreadable = observe(first, 'SWE1', 'app#1', token(null), at(5))
    assert.deepEqual(unreadable['SWE1|app#1'], { token: token(null), at: at(0).toISOString() })
  })

  it('同じ部下の別の issue の分は捨てる。ほかの部下の分は残す', () => {
    const seen = { ...observe({}, 'SWE1', 'app#1', token('a'), at(0)), ...observe({}, 'SWE2', 'app#1', token('x'), at(0)) }
    const next = observe(seen, 'SWE1', 'app#2', token('c'), at(5))
    assert.deepEqual(Object.keys(next).toSorted(), ['SWE1|app#2', 'SWE2|app#1'])
    assert.equal(seenKey('SWE1', 'app#2'), 'SWE1|app#2')
  })
})

describe('readSeen と writeSeen', () => {
  it('書いたものを読み戻す。無ければ空', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-seen-')))
    assert.deepEqual(readSeen(p), {})
    const seen = observe({}, 'SWE1', 'app#1', { board: 'b', github: null }, new Date(Date.UTC(2026, 10, 3, 15, 0)))
    writeSeen(p, seen)
    assert.deepEqual(readSeen(p), seen)
  })

  it('壊れた中身は空、形の違う項目 (印が無い、時刻が読めない、配列) は捨てる', () => {
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
    writeFileSync(p.dispatchSeen, '{ 壊れた')
    assert.deepEqual(readSeen(p), {})
  })
})
