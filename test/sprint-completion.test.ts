import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gh } from '../src/adapters/github/gh.ts'
import { projectBoardSource } from '../src/adapters/github/project-board.ts'
import { loadFetchedSnapshot, refreshSnapshot as refreshWith } from '../src/board/snapshot.ts'
import type { Config } from '../src/config.ts'
import { loadCompletions, newlyFinished, recordCompletions, type Completion } from '../src/sprint/completion.ts'
import type { StatusEvent } from '../src/sprint/effort.ts'
import { formatCompletions, formatPoints } from '../src/sprint/report.ts'
import { appendLine, paths, readText, writeJson, type Paths } from '../src/store.ts'
import { config as base, historyOf, issue, snapshot } from './helpers.ts'

/** GitHub のアダプタで取り直す。gh は、試験ごとに PATH の先頭に置いた偽物が答える。 */
const refreshSnapshot = (p: Paths, c: Config, now: Date) => refreshWith(p, c, now, projectBoardSource(gh, c))

const config: Config = {
  ...base,
  sprint: { checkpoints: ['08:00', '13:00', '21:00'], utcOffset: '+09:00', pointsField: 'ストーリーポイント', overrunField: '超過', pointBudgets: { '1': 1, '2': 1, '3': 2, '5': 3, '8': 5 } },
}
const jst = (text: string) => new Date(`${text}+09:00`)
/** 10/29 09:00 に作業中に入り、10/30 14:00 に済み。またいだ節目は 13:00、21:00、08:00、13:00 の 4 つ */
const START = jst('2026-10-29T09:00:00')
const NOW = jst('2026-10-30T14:00:00')
const timeline = (done: string): readonly StatusEvent[] => [
  { at: START.toISOString(), status: config.statuses.doing },
  { at: jst('2026-10-30T13:50:00').toISOString(), status: done },
]
const doingBefore = (number: number, overrides: Parameters<typeof issue>[1] = {}) =>
  issue(number, { status: config.statuses.doing, points: 3, statusEvents: [{ at: START.toISOString(), status: config.statuses.doing }], ...overrides })
const finished = (number: number, status: string, overrides: Parameters<typeof issue>[1] = {}) => issue(number, { status, points: 3, ...overrides })
const setup = () => paths(mkdtempSync(join(tmpdir(), 'scrum-completion-')))

describe('newlyFinished', () => {
  it('前の控えで作業中だった issue が、今の控えで完了かリリース待ちになったものを返す', () => {
    const previous = snapshot([doingBefore(1), doingBefore(2), doingBefore(3)])
    const fresh = snapshot([finished(1, config.statuses.done), finished(2, config.statuses.release), doingBefore(3)])
    assert.deepEqual(newlyFinished(previous, fresh, config).map((pair) => pair.item.number), [1, 2])
  })

  it('前の控えで作業中でなかった issue (バックログから直接完了) と、前の控えが無いときは、返さない', () => {
    const previous = snapshot([issue(1, { status: config.statuses.backlog })])
    const fresh = snapshot([finished(1, config.statuses.done)])
    assert.deepEqual(newlyFinished(previous, fresh, config), [])
    assert.deepEqual(newlyFinished(null, fresh, config), [])
  })

  it('作業中のまま、次にやるに戻ったもの、除く作者の issue、PR は、返さない', () => {
    const previous = snapshot([doingBefore(1), doingBefore(2, { author: 'external-dev' }), doingBefore(3)])
    const fresh = snapshot([issue(1, { status: config.statuses.next }), finished(2, config.statuses.done, { author: 'external-dev' }), finished(3, config.statuses.done, { kind: 'pr' })])
    assert.deepEqual(newlyFinished(previous, fresh, config), [])
  })
})

describe('recordCompletions', () => {
  const previous = snapshot([doingBefore(1)])
  const fresh = snapshot([finished(1, config.statuses.done)])

  it('Status の変化の記録から、ポイント・目安・かかった節目を数えて、1 件 1 行で残す', () => {
    const p = setup()
    const found = recordCompletions(p, previous, fresh, config, NOW, () => new Map([['app#1', timeline(config.statuses.done)]]))
    assert.deepEqual(found, [{ label: 'app#1', points: 3, budget: 2, effort: 4, detectedAt: NOW.toISOString(), status: config.statuses.done, exact: true }])
    assert.deepEqual(loadCompletions(p), found)
  })

  it('止まっていた節目は、かかった節目に数えない (節目の記録の止まり)', () => {
    const p = setup()
    const records = [{ scheduledFor: jst('2026-10-29T21:00:00').toISOString(), recordedAt: jst('2026-10-29T21:01:00').toISOString(), items: [{ label: 'app#1', points: 3, budget: 2, effort: 2, over: 0, reason: '判断待ち', tanto: null }] }]
    appendLine(p.checkpoints, JSON.stringify(records[0]))
    const [one] = recordCompletions(p, previous, fresh, config, NOW, () => new Map([['app#1', timeline(config.statuses.done)]]))
    assert.equal(one?.effort, 3)
  })

  it('Status の変化を読めなければ、前の控えの記録に済んだ時刻を足して数え、近似と印を付ける', () => {
    const p = setup()
    const [one] = recordCompletions(p, previous, fresh, config, NOW, () => null)
    assert.equal(one?.effort, 4)
    assert.equal(one?.exact, false)
  })

  it('前の控えにも記録が無ければ、かかった節目は null (分からない) で残す', () => {
    const p = setup()
    const [one] = recordCompletions(p, snapshot([doingBefore(1, { statusEvents: undefined })]), fresh, config, NOW, () => null)
    assert.equal(one?.effort, null)
    assert.equal(one?.points, 3)
  })

  it('リリース待ちも、済みとして残す', () => {
    const p = setup()
    const [one] = recordCompletions(p, previous, snapshot([finished(1, config.statuses.release)]), config, NOW, () => new Map([['app#1', timeline(config.statuses.release)]]))
    assert.equal(one?.status, config.statuses.release)
  })

  it('作業中と完了を行き来した issue が、後でもう一度済んだら、もう一度記録する (記録が前の控えより前なら、やり直しではない)', () => {
    const p = setup()
    const earlier = { label: 'app#1', points: 3, budget: 2, effort: 1, detectedAt: '2026-10-07T00:00:00.000Z', status: config.statuses.done, exact: true }
    appendLine(p.completions, JSON.stringify(earlier))
    const found = recordCompletions(p, previous, fresh, config, NOW, () => new Map([['app#1', timeline(config.statuses.done)]]))
    assert.deepEqual(found.map((one) => one.label), ['app#1'])
    assert.deepEqual(loadCompletions(p).map((one) => one.detectedAt), [earlier.detectedAt, NOW.toISOString()])
  })

  it('sprint の設定が無ければ何もしない。済んだものが無ければ、Status の変化も読まない', () => {
    const p = setup()
    assert.deepEqual(recordCompletions(p, previous, fresh, base, NOW, () => assert.fail('読まない')), [])
    let called = 0
    recordCompletions(p, snapshot([doingBefore(1)]), snapshot([doingBefore(1)]), config, NOW, () => {
      called += 1
      return null
    })
    assert.equal(called, 0)
    assert.equal(readText(p.completions), '')
  })

  it('読めない行は飛ばして、読める行を返す', () => {
    const p = setup()
    appendLine(p.completions, 'not json')
    appendLine(p.completions, JSON.stringify({ label: 'app#9', points: 1, budget: 1, effort: 0, detectedAt: NOW.toISOString(), status: '完了', exact: true }))
    assert.deepEqual(loadCompletions(p).map((one) => one.label), ['app#9'])
  })
})

describe('refreshSnapshot が、済んだ issue を記録する', () => {
  const node = (number: number, status: string) => ({
    id: `PVTI_${number}`,
    type: 'ISSUE',
    status: { name: status },
    points: { number: 3 },
    content: { number, title: `issue ${number}`, state: 'OPEN', author: { login: 'owner' }, repository: { nameWithOwner: 'example-org/app' } },
  })
  function withGh(page: unknown, run: () => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
    const listing = `case "$*" in *'--state open'*'--limit 1000'*) printf '[]' ;; *) exit 2 ;; esac`
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/sh\ncase "$1" in\n  api) case "$*" in *--paginate*) printf '%s' '${JSON.stringify([page])}' ;; *) printf '{"data":{}}' ;; esac ;;\n  issue) ${listing} ;;\n  pr) ${listing} ;;\nesac\n`,
    )
    chmodSync(join(dir, 'gh'), 0o755)
    const original = process.env.PATH
    process.env.PATH = `${dir}:${original}`
    try {
      run()
    } finally {
      process.env.PATH = original
    }
  }
  const pageOfItems = (items: readonly (readonly [number, string])[]) => ({
    data: { node: { items: { totalCount: items.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: items.map(([number, status]) => node(number, status)) } } },
  })
  const page = (status: string) => pageOfItems([[1, status]])
  const doingItem = (number: number) =>
    issue(number, { status: config.statuses.doing, points: 3, repo: 'example-org/app', statusEvents: [{ at: START.toISOString(), status: config.statuses.doing }] })
  const oneRepo = { ...config, repos: ['example-org/app'] }

  it('控えを書いた後で、作業中から完了になった issue を、1 件記録する (Status の変化を読めなくても、前の控えで近似して)', () => {
    const p = setup()
    writeJson(p.snapshot, snapshot([issue(1, { status: config.statuses.doing, points: 3, repo: 'example-org/app', statusEvents: [{ at: START.toISOString(), status: config.statuses.doing }] })]))
    withGh(page(config.statuses.done), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    const [one] = loadCompletions(p)
    assert.equal(one?.label, 'app#1')
    assert.equal(one?.effort, 4)
    assert.equal(one?.exact, false)
    assert.equal(JSON.parse(readFileSync(p.snapshot, 'utf8')).items[0].status, config.statuses.done)
  })

  it('記録に失敗しても、控えは書いてあり、取り直しは成功のままにして、errors.log に残す', () => {
    const p = setup()
    writeJson(p.snapshot, snapshot([issue(1, { status: config.statuses.doing, points: 3, repo: 'example-org/app', statusEvents: [{ at: START.toISOString(), status: config.statuses.doing }] })]))
    mkdirSync(p.completions, { recursive: true })
    withGh(page(config.statuses.done), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    assert.equal(JSON.parse(readFileSync(p.snapshot, 'utf8')).items[0].status, config.statuses.done)
    assert.match(readFileSync(p.errors, 'utf8'), /completions: /)
  })

  it('フックが Status を直して書いた控え (完了) ではなく、最後に取り直して取れた控え (作業中) と比べて、記録する', () => {
    const p = setup()
    writeJson(p.fetchedSnapshot, snapshot([doingItem(1)]))
    // Status を書き換えるスクリプトの後に、フックが Status を完了に直して書いた控え
    writeJson(p.snapshot, snapshot([{ ...doingItem(1), status: config.statuses.done }]))
    withGh(page(config.statuses.done), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    assert.deepEqual(loadCompletions(p).map((one) => one.label), ['app#1'])
    assert.equal(loadFetchedSnapshot(p)?.items[0]?.status, config.statuses.done)
  })

  it('最後に取った控えが無ければ (最初の取り直し)、いまの控えと比べる', () => {
    const p = setup()
    writeJson(p.snapshot, snapshot([doingItem(1)]))
    withGh(page(config.statuses.done), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    assert.deepEqual(loadCompletions(p).map((one) => one.label), ['app#1'])
    assert.equal(loadFetchedSnapshot(p)?.items[0]?.status, config.statuses.done)
  })

  it('記録に失敗したら、最後に取った控えを進めず、次の取り直しで、同じ issue をもう一度見つけて記録する', () => {
    const p = setup()
    writeJson(p.fetchedSnapshot, snapshot([doingItem(1)]))
    mkdirSync(p.completions, { recursive: true })
    withGh(page(config.statuses.done), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    assert.equal(loadFetchedSnapshot(p)?.items[0]?.status, config.statuses.doing)
    rmSync(p.completions, { recursive: true })
    withGh(page(config.statuses.done), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    assert.deepEqual(loadCompletions(p).map((one) => one.label), ['app#1'])
    assert.equal(loadFetchedSnapshot(p)?.items[0]?.status, config.statuses.done)
  })

  it('記録の途中で失敗して、やり直すとき、先に記録できた issue は重ねて記録しない', () => {
    const p = setup()
    writeJson(p.fetchedSnapshot, snapshot([doingItem(1), doingItem(2)]))
    appendLine(p.completions, JSON.stringify({ label: 'app#1', points: 3, budget: 2, effort: 4, detectedAt: NOW.toISOString(), status: config.statuses.done, exact: true }))
    withGh(pageOfItems([[1, config.statuses.done], [2, config.statuses.done]]), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    assert.deepEqual(loadCompletions(p).map((one) => one.label), ['app#1', 'app#2'])
  })

  it('作業中のままなら、何も記録しない', () => {
    const p = setup()
    writeJson(p.snapshot, snapshot([issue(1, { status: config.statuses.doing, points: 3, repo: 'example-org/app' })]))
    withGh(page(config.statuses.doing), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    assert.deepEqual(loadCompletions(p), [])
  })
})

describe('済んだ issue の予実の表示', () => {
  const one = (label: string, points: number | null, budget: number | null, effort: number | null, detectedAt: string, exact = true): Completion => ({
    label,
    points,
    budget,
    effort,
    detectedAt,
    status: '完了',
    exact,
  })
  const data: readonly Completion[] = [
    one('app#1', 3, 2, 4, '2026-10-30T01:00:00Z'),
    one('app#2', 3, 2, 2, '2026-10-30T02:00:00Z'),
    one('app#3', 3, 2, 0, '2026-10-30T03:00:00Z', false),
    one('app#4', 5, 3, 3, '2026-10-30T04:00:00Z'),
    one('app#5', 2, 1, null, '2026-10-30T05:00:00Z'),
    one('app#6', null, null, 1, '2026-10-30T06:00:00Z'),
  ]

  it('済んだ issue を新しい順に並べ、近似には印を付ける。ポイントや節目が分からないものは - にする', () => {
    const lines = formatCompletions(data)
    const rows = lines.slice(lines.indexOf('issue\tポイント\t目安\tかかった節目\t備考') + 1, lines.indexOf('ポイントごとの予実 (かかった節目の中央値と幅)') - 1)
    assert.deepEqual(rows, ['app#6\t-\t-\t1\t', 'app#5\t2\t1\t-\t', 'app#4\t5\t3\t3\t', 'app#3\t3\t2\t0\t近似', 'app#2\t3\t2\t2\t', 'app#1\t3\t2\t4\t'])
  })

  it('ポイントごとに、件数、かかった節目の中央値と幅、目安を超えた件数を出す。ポイントか節目が分からないものは数えない', () => {
    const lines = formatCompletions(data)
    assert.deepEqual(lines.slice(lines.indexOf('ポイント\t目安\t件数\t中央値\t幅\t目安を超えた件数') + 1), ['3\t2\t3\t2\t0〜4\t1', '5\t3\t1\t3\t3〜3\t0'])
  })

  it('件数が偶数なら、真ん中の 2 つの平均 (小数 1 桁) を出す', () => {
    const lines = formatCompletions([one('a#1', 3, 2, 1, '2026-10-30T01:00:00Z'), one('a#2', 3, 2, 2, '2026-10-30T02:00:00Z')])
    assert.equal(lines.at(-1), '3\t2\t2\t1.5\t1〜2\t0')
  })

  it('同じ issue の記録が複数あれば (行き来した)、新しいものだけを、一覧にもポイントごとにも使う', () => {
    const lines = formatCompletions([
      one('app#7', 3, 2, 1, '2026-10-30T01:00:00Z'),
      one('app#7', 3, 2, 3, '2026-10-30T09:00:00Z'),
      one('app#8', 3, 2, 0, '2026-10-30T05:00:00Z'),
    ])
    const rows = lines.slice(lines.indexOf('issue\tポイント\t目安\tかかった節目\t備考') + 1, lines.indexOf('ポイントごとの予実 (かかった節目の中央値と幅)') - 1)
    assert.deepEqual(rows, ['app#7\t3\t2\t3\t', 'app#8\t3\t2\t0\t'])
    assert.equal(lines.at(-1), '3\t2\t2\t1.5\t0〜3\t1')
  })

  it('記録が無ければ、何も出さない。新しい順の一覧は、最大 20 件にする', () => {
    assert.deepEqual(formatCompletions([]), [])
    const many = Array.from({ length: 25 }, (_, index) => one(`a#${index}`, 1, 1, 0, `2026-10-30T${String(index).padStart(2, '0')}:00:00Z`))
    const lines = formatCompletions(many)
    const rows = lines.slice(lines.indexOf('issue\tポイント\t目安\tかかった節目\t備考') + 1, lines.indexOf('ポイントごとの予実 (かかった節目の中央値と幅)') - 1)
    assert.equal(rows.length, 20)
    assert.equal(rows[0]?.startsWith('a#24\t'), true)
    assert.equal(lines.at(-1), '1\t1\t25\t0\t0〜0\t0')
  })

  it('scrum points の表の下に出す。記録が無いときは、今までの表のまま', () => {
    const snap = snapshot([])
    const without = formatPoints(snap, historyOf(), config, NOW)
    assert.equal(without.includes('済んだ issue の予実'), false)
    const withData = formatPoints(snap, historyOf(), config, NOW, data)
    assert.equal(withData.startsWith(without), true)
    assert.equal(withData.includes('済んだ issue の予実'), true)
  })
})
