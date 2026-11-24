import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBoardCommands } from '../src/adapters/github/action-reader.ts'
import { gh } from '../src/adapters/github/gh.ts'
import { parseItemPages, projectBoardSource } from '../src/adapters/github/project-board.ts'
import { checkGuard } from '../src/board/commands.ts'
import { lintBoard } from '../src/board/rules.ts'
import { isRefreshDue, refreshSnapshot as refreshWith } from '../src/board/snapshot.ts'
import type { Config } from '../src/config.ts'
import { paths, writeJson, type Paths } from '../src/store.ts'
import { config, issue, snapshot } from './helpers.ts'

/** GitHub のアダプタで取り直す。gh は、試験ごとに PATH の先頭に置いた偽物が答える。 */
const refreshSnapshot = (p: Paths, c: Config, now: Date) => refreshWith(p, c, now, projectBoardSource(gh, c))

const page = JSON.parse(readFileSync(new URL('./fixtures/graphql-page.json', import.meta.url), 'utf8'))

/** content を持つ issue の項目の、取得結果の1件。 */
function node(number: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `PVTI_${number}`,
    type: 'ISSUE',
    status: { name: 'Backlog' },
    content: { number, title: `issue ${number}`, state: 'OPEN', author: { login: 'owner' }, repository: { nameWithOwner: 'example-org/app' } },
    ...overrides,
  }
}

function pageOf(nodes: readonly unknown[], totalCount: number = nodes.length) {
  return { data: { node: { items: { totalCount, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } }
}

/** 実際の取得結果と同じく、項目の総数 (totalCount) を持つ、フィクスチャの1ページ。 */
const fixturePage = structuredClone(page)
fixturePage.data.node.items.totalCount = fixturePage.data.node.items.nodes.length

const unreadable = (number: number) => node(number, { content: null })

describe('parseItemPages', () => {
  it('slurp したページの配列から項目を取り出す', () => {
    const items = parseItemPages(JSON.stringify([fixturePage]))
    assert.equal(items.length, 4)
    assert.equal(items[0]?.number, 101)
  })

  it('複数のページの項目をつなげる', () => {
    const items = parseItemPages(JSON.stringify([pageOf([node(1), node(2)], 3), pageOf([node(3)], 3)]))
    assert.deepEqual(items.map((item) => item.number), [1, 2, 3])
  })

  it('slurp していない1ページ分のオブジェクトは、ページの配列でないので投げる', () => {
    assert.throws(() => parseItemPages(JSON.stringify(page)), /is not an array of pages/)
  })

  it('空の配列は投げる', () => {
    assert.throws(() => parseItemPages('[]'), /is not an array of pages/)
  })

  it('node が null のページ (権限が無いとき) は、何ページ目かを添えて投げる', () => {
    const broken = { data: { node: null }, errors: [{ message: 'Could not resolve to a node' }] }
    assert.throws(() => parseItemPages(JSON.stringify([pageOf([node(1)], 2), broken])), /Page 2 of the board fetch result has no list of items/)
  })

  it('総数より少ししか取れていない (ページが途中で切れた) 結果は、投げる', () => {
    const firstThree = Array.from({ length: 300 }, (_, i) => node(i + 1))
    assert.throws(() => parseItemPages(JSON.stringify([pageOf(firstThree, 500)])), /Only 300 of 500 board items were fetched/)
  })

  it('取得中にボードから数件消えた程度の差なら、通す', () => {
    const nodes = Array.from({ length: 997 }, (_, i) => node(i + 1))
    assert.equal(parseItemPages(JSON.stringify([pageOf(nodes, 1000)])).length, 997)
  })

  it('総数 (totalCount) が無い結果は、突き合わせられないので投げる', () => {
    const noTotal = { data: { node: { items: { nodes: [node(1)] } } } }
    assert.throws(() => parseItemPages(JSON.stringify([noTotal])), /totalCount/)
  })

  it('項目が 0 件なら、控えを書き換えないよう投げる', () => {
    assert.throws(() => parseItemPages(JSON.stringify([pageOf([])])), /The board has 0 items/)
  })

  it('issue と PR の半分を超える項目の中身が読めなければ、投げる', () => {
    const nodes = [...Array.from({ length: 4 }, (_, i) => node(i + 1)), ...Array.from({ length: 8 }, (_, i) => unreadable(i + 100))]
    assert.throws(() => parseItemPages(JSON.stringify([pageOf(nodes)])), /The content of 8 of \d+ issue and PR items cannot be read/)
  })

  it('中身が読めない項目が半分以下なら、通す', () => {
    const nodes = [...Array.from({ length: 8 }, (_, i) => node(i + 1)), ...Array.from({ length: 4 }, (_, i) => unreadable(i + 100))]
    assert.equal(parseItemPages(JSON.stringify([pageOf(nodes)])).length, 12)
  })

  it('件数が少ないボードでは、読めない項目の割合を見ない', () => {
    const nodes = [node(1), unreadable(2), unreadable(3)]
    assert.equal(parseItemPages(JSON.stringify([pageOf(nodes)])).length, 3)
  })

  it('下書きは、中身が無いのが普通なので、読めない項目に数えない', () => {
    const drafts = Array.from({ length: 12 }, (_, i) => ({ id: `PVTI_d${i}`, type: 'DRAFT_ISSUE', content: { title: `draft ${i}` } }))
    assert.equal(parseItemPages(JSON.stringify([pageOf([node(1), ...drafts])])).length, 13)
  })
})

describe('refreshSnapshot は、取得が壊れたとき前の控えを守る', () => {
  type FakeGhOptions = {
    /** gh issue list の出力 (リポジトリごとに同じものを返す)。 */
    readonly issues?: string
    /** gh pr list の出力 (リポジトリごとに同じものを返す)。 */
    readonly prs?: string
    /** 真なら、gh pr list が失敗する。 */
    readonly prsFail?: boolean
    /** ボードの項目を 1 件ずつ読む graphql (--paginate が無い api) の出力。 */
    readonly read?: string
    /** 真なら、1 件ずつ読む graphql が失敗する。 */
    readonly readFails?: boolean
  }

  /** PATH の先頭に偽の gh を置いて、ページを読む graphql、1 件ずつ読む graphql、issue list の出力を決める。 */
  function withFakeGh(graphqlOutput: string, run: () => void, options: FakeGhOptions = {}): void {
    const { issues = '[{"number":7,"author":{"login":"owner"}}]', prs = '[]', prsFail = false, read = '{"data":{}}', readFails = false } = options
    const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
    const readBranch = readFails ? `echo 'read failed' >&2; exit 1` : `printf '%s' '${read}'`
    const prBranch = prsFail ? `echo 'pr list failed' >&2; exit 1` : `printf '%s' '${prs}'`
    /** issue list と pr list は、開いているものを 1000 件まで読む引数のときだけ答える (引数が変わったら落ちる)。 */
    const listGuard = `case "$*" in *'--state open'*'--limit 1000'*) ;; *) echo 'unexpected args' >&2; exit 2 ;; esac;`
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/sh\ncase "$1" in\n  api) case "$*" in\n    *--paginate*) printf '%s' '${graphqlOutput}' ;;\n    *) ${readBranch} ;;\n  esac ;;\n  issue) ${listGuard} printf '%s' '${issues}' ;;\n  pr) ${listGuard} ${prBranch} ;;\nesac\n`,
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

  function setup() {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-')))
    const previous = snapshot([issue(7)])
    writeJson(p.snapshot, previous)
    return { p, previous }
  }

  it('項目が 0 件の取得結果では、控えを書き換えず、errors.log に残す', () => {
    const { p, previous } = setup()
    withFakeGh(JSON.stringify([pageOf([])]), () => {
      assert.equal(refreshSnapshot(p, config, new Date('2026-10-23T00:00:00Z')), null)
    })
    assert.deepEqual(JSON.parse(readFileSync(p.snapshot, 'utf8')), previous)
    assert.match(readFileSync(p.errors, 'utf8'), /refresh: The board has 0 items/)
  })

  it('総数より少ししか取れていない結果では、控えを書き換えず、errors.log に残す', () => {
    const { p, previous } = setup()
    const truncated = pageOf(Array.from({ length: 300 }, (_, i) => node(i + 1)), 500)
    withFakeGh(JSON.stringify([truncated]), () => {
      assert.equal(refreshSnapshot(p, config, new Date('2026-10-23T00:00:00Z')), null)
    })
    assert.deepEqual(JSON.parse(readFileSync(p.snapshot, 'utf8')), previous)
    assert.match(readFileSync(p.errors, 'utf8'), /Only 300 of 500 board items were fetched/)
  })

  it('正しい取得結果では、控えを書き換える', () => {
    const { p } = setup()
    withFakeGh(JSON.stringify([pageOf([node(7), node(8)])]), () => {
      const fresh = refreshSnapshot(p, config, new Date('2026-10-23T00:00:00Z'))
      assert.equal(fresh?.items.length, 2)
      assert.equal(fresh?.openIssues.length, config.repos.length)
    })
    assert.equal(JSON.parse(readFileSync(p.snapshot, 'utf8')).items.length, 2)
  })

  describe('ボードに入っているのに、ページの一覧に出ない項目', () => {
    const now = new Date('2026-11-05T00:00:00Z')
    const oneRepo = { ...config, repos: ['example-org/app'] }
    const issues = '[{"number":7,"author":{"login":"owner"}},{"number":8,"author":{"login":"owner"}}]'
    /** ページの一覧には #7 しか出ない (総数は 2 で、許される数件の欠けの中に収まる形。足し込みは総数と関係なく、一覧に無いものを 1 件ずつ読む)。 */
    const pagedWithoutEight = JSON.stringify([pageOf([node(7)], 2)])
    const readResult = (nodes: readonly unknown[]) => JSON.stringify({ data: { c0: { issue: { projectItems: { nodes } } } } })
    const offBoard = (found: ReturnType<typeof refreshSnapshot>) => (found === null ? [] : lintBoard(found, oneRepo, now)).filter((one) => one.rule === 'B-OFF-BOARD')

    it('一覧に出なかった開いた issue が、実際はボードに入っているなら、1 件ずつ読んで控えに足し、B-OFF-BOARD を出さない', () => {
      const { p } = setup()
      withFakeGh(
        pagedWithoutEight,
        () => {
          const fresh = refreshSnapshot(p, oneRepo, now)
          assert.deepEqual(fresh?.items.map((item) => item.number), [7, 8])
          assert.equal(fresh?.items.find((item) => item.number === 8)?.status, 'Next')
          assert.deepEqual(offBoard(fresh), [])
        },
        { issues, read: readResult([{ ...node(8, { status: { name: 'Next' } }), project: { id: config.projectId } }]) },
      )
      assert.deepEqual(JSON.parse(readFileSync(p.snapshot, 'utf8')).items.map((item: { number: number }) => item.number), [7, 8])
    })

    it('1 件ずつ読んでもボードに入っていない issue は、足さず、B-OFF-BOARD を出す', () => {
      const { p } = setup()
      withFakeGh(
        pagedWithoutEight,
        () => {
          const fresh = refreshSnapshot(p, oneRepo, now)
          assert.deepEqual(fresh?.items.map((item) => item.number), [7])
          assert.deepEqual(offBoard(fresh).map((one) => one.subject), ['app#8'])
        },
        { issues, read: readResult([]) },
      )
    })

    it('1 件ずつ読むのに失敗したら、控えを書き換えず、errors.log に残す (欠けたまま書いて、誤って指摘しない)', () => {
      const { p, previous } = setup()
      withFakeGh(
        pagedWithoutEight,
        () => {
          assert.equal(refreshSnapshot(p, oneRepo, now), null)
        },
        { issues, readFails: true },
      )
      assert.deepEqual(JSON.parse(readFileSync(p.snapshot, 'utf8')), previous)
      assert.match(readFileSync(p.errors, 'utf8'), /refresh: gh exited with 1: read failed/)
    })

    it('一覧に欠けが無ければ、1 件ずつ読まない (読み取りが失敗する gh でも、控えを書ける)', () => {
      const { p } = setup()
      withFakeGh(
        JSON.stringify([pageOf([node(7)])]),
        () => {
          const fresh = refreshSnapshot(p, oneRepo, now)
          assert.deepEqual(fresh?.items.map((item) => item.number), [7])
        },
        { issues: '[{"number":7,"author":{"login":"owner"}}]', readFails: true },
      )
    })
  })

  describe('ボードに入っているのに、ページの一覧に出ない開いた PR', () => {
    const now = new Date('2026-11-05T00:00:00Z')
    const oneRepo = { ...config, repos: ['example-org/app'] }
    const issues = '[{"number":7,"author":{"login":"owner"}}]'
    const prs = '[{"number":9,"author":{"login":"owner"}}]'
    const pagedWithoutNine = JSON.stringify([pageOf([node(7)], 1)])
    const prNode = (overrides: Record<string, unknown> = {}) => ({
      ...node(9, { type: 'PULL_REQUEST', status: null, ...overrides }),
      project: { id: config.projectId },
    })
    /** 別名 c0 の PR の、projectItems の項目の並びを返す、1 件ずつ読む graphql の出力。 */
    const prReadResult = (nodes: readonly unknown[]) => JSON.stringify({ data: { c0: { pullRequest: { projectItems: { nodes } } } } })
    const findings = (found: ReturnType<typeof refreshSnapshot>, rule: string) =>
      (found === null ? [] : lintBoard(found, oneRepo, now)).filter((one) => one.rule === rule)

    it('実際はボードに入っているなら、1 件ずつ読んで控えに足す。書き込みの前の守りが、その PR の番号への Status を止める', () => {
      const { p } = setup()
      withFakeGh(
        pagedWithoutNine,
        () => {
          const fresh = refreshSnapshot(p, oneRepo, now)
          assert.deepEqual(fresh?.items.map((item) => [item.number, item.kind]), [[7, 'issue'], [9, 'pr']])
          const reason = checkGuard(fresh ?? snapshot([]), parseBoardCommands('set-status 9 "In Progress"', oneRepo), oneRepo)
          assert.match(reason ?? '', /app#9 is a PR/)
        },
        { issues, prs, read: prReadResult([prNode()]) },
      )
    })

    it('Status が付いた PR を足したときは、B-PR-STATUS が出る', () => {
      const { p } = setup()
      withFakeGh(
        pagedWithoutNine,
        () => {
          const fresh = refreshSnapshot(p, oneRepo, now)
          assert.deepEqual(findings(fresh, 'B-PR-STATUS').map((one) => one.subject), ['app#9'])
        },
        { issues, prs, read: prReadResult([prNode({ status: { name: 'In Progress' } })]) },
      )
    })

    it('PR は、控えの開いた issue に入れない。B-OFF-BOARD は、足された PR にも、足されなかった PR にも出ない', () => {
      const { p } = setup()
      withFakeGh(
        pagedWithoutNine,
        () => {
          const added = refreshSnapshot(p, oneRepo, now)
          assert.deepEqual(added?.openIssues.map((open) => open.number), [7])
          assert.deepEqual(findings(added, 'B-OFF-BOARD'), [])
        },
        { issues, prs, read: prReadResult([prNode()]) },
      )
      withFakeGh(
        pagedWithoutNine,
        () => {
          const notAdded = refreshSnapshot(p, oneRepo, now)
          assert.deepEqual(notAdded?.items.map((item) => item.number), [7])
          assert.deepEqual(findings(notAdded, 'B-OFF-BOARD'), [])
        },
        { issues, prs, read: prReadResult([]) },
      )
    })

    it('1 件ずつ読んでもボードに入っていない PR は、足さない', () => {
      const { p } = setup()
      withFakeGh(
        pagedWithoutNine,
        () => {
          assert.deepEqual(refreshSnapshot(p, oneRepo, now)?.items.map((item) => item.number), [7])
        },
        { issues, prs, read: prReadResult([]) },
      )
    })

    it('gh pr list が失敗したら、控えを書き換えず、errors.log に残す', () => {
      const { p, previous } = setup()
      withFakeGh(
        pagedWithoutNine,
        () => {
          assert.equal(refreshSnapshot(p, oneRepo, now), null)
        },
        { issues, prsFail: true },
      )
      assert.deepEqual(JSON.parse(readFileSync(p.snapshot, 'utf8')), previous)
      assert.match(readFileSync(p.errors, 'utf8'), /refresh: gh exited with 1: pr list failed/)
    })

    it('一覧にある PR は、読み取りが失敗する gh でも、読まずに控えを書ける', () => {
      const { p } = setup()
      withFakeGh(
        JSON.stringify([pageOf([node(7), prNode()])]),
        () => {
          assert.deepEqual(refreshSnapshot(p, oneRepo, now)?.items.map((item) => item.number), [7, 9])
        },
        { issues, prs, readFails: true },
      )
    })
  })

  it('取得に失敗したら、gh の出力をそのまま log に残す (次に起きたとき原因を調べられるように)', () => {
    const { p } = setup()
    const truncated = JSON.stringify([pageOf(Array.from({ length: 40 }, (_, i) => node(i + 1)), 500)])
    withFakeGh(truncated, () => {
      refreshSnapshot(p, config, new Date('2026-10-23T00:00:00Z'))
    })
    const saved = readdirSync(join(p.dir, 'log')).filter((name) => name.startsWith('fetch-failed-'))
    assert.equal(saved.length, 1)
    assert.equal(readFileSync(join(p.dir, 'log', saved[0] ?? ''), 'utf8'), truncated)
  })

  it('失敗の記録は新しい5件だけ残す', () => {
    const { p } = setup()
    withFakeGh(JSON.stringify([pageOf([])]), () => {
      for (let minute = 0; minute < 7; minute++) {
        refreshSnapshot(p, config, new Date(Date.UTC(2026, 9, 23, 0, minute)))
      }
    })
    const saved = readdirSync(join(p.dir, 'log')).filter((name) => name.startsWith('fetch-failed-')).toSorted()
    assert.equal(saved.length, 5)
    assert.match(saved[0] ?? '', /2026-10-23T00-02/)
  })
})

describe('isRefreshDue', () => {
  const t0 = new Date('2026-10-23T00:00:00Z')
  const after = (seconds: number) => new Date(t0.getTime() + seconds * 1000)

  it('控えが古くても、前に試してから refreshSeconds 経つまでは取り直さない (失敗が続いても上限を使い切らない)', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-')))
    writeJson(p.snapshot, { ...snapshot([issue(7)]), fetchedAt: '2026-10-22T00:00:00Z' })
    withFakeGhStatic(JSON.stringify([pageOf([])]), () => refreshSnapshot(p, config, t0))
    assert.equal(isRefreshDue(p, config, after(60)), false)
    assert.equal(isRefreshDue(p, config, after(config.refreshSeconds + 1)), true)
  })

  it('控えが無ければ、試したことが無い限り取り直す', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-')))
    assert.equal(isRefreshDue(p, config, t0), true)
  })
})

function withFakeGhStatic(graphqlOutput: string, run: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\ncase "$1" in\n  api) printf '%s' '${graphqlOutput}' ;;\n  issue) printf '[]' ;;\n  pr) printf '[]' ;;\nesac\n`)
  chmodSync(join(dir, 'gh'), 0o755)
  const original = process.env.PATH
  process.env.PATH = `${dir}:${original}`
  try {
    run()
  } finally {
    process.env.PATH = original
  }
}
