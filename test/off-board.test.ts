import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { itemsQuery } from '../src/board/snapshot.ts'
import { offBoardCandidates, READ_BATCH_SIZE, readMissingItems, readQuery } from '../src/board/off-board.ts'
import type { OpenIssue } from '../src/board/types.ts'
import { config, issue, pr, REPO } from './helpers.ts'

const open = (number: number, overrides: Partial<OpenIssue> = {}): OpenIssue => ({ repo: REPO, number, author: 'owner', ...overrides })

/** 1 件の issue を、入っているプロジェクトの項目として読んだ結果の 1 件 (config のボードの項目)。 */
function projectNode(number: number, overrides: Record<string, unknown> = {}) {
  return {
    project: { id: config.projectId },
    id: `PVTI_${number}`,
    type: 'ISSUE',
    status: { name: '次にやる' },
    content: { number, title: `issue ${number}`, state: 'OPEN', author: { login: 'owner' }, repository: { nameWithOwner: REPO } },
    ...overrides,
  }
}

/** 別名 c0、c1、… ごとに、projectItems の項目の並びを返す、1 件ずつ読む graphql の出力。null は、issue が読めない形。 */
function readResult(...perIssue: readonly (readonly unknown[] | null)[]): string {
  return JSON.stringify({
    data: Object.fromEntries(perIssue.map((nodes, index) => [`c${index}`, nodes === null ? null : { issue: { projectItems: { nodes } } }])),
  })
}

/** PR の読み結果。別名 c0、c1、… ごとに、projectItems の項目の並びを返す (PR は pullRequest の下に入る)。 */
function readResultPr(...perPr: readonly (readonly unknown[] | null)[]): string {
  return JSON.stringify({
    data: Object.fromEntries(perPr.map((nodes, index) => [`c${index}`, nodes === null ? null : { pullRequest: { projectItems: { nodes } } }])),
  })
}

/** 1 件の PR を、入っているプロジェクトの項目として読んだ結果の 1 件。 */
const prNode = (number: number, overrides: Record<string, unknown> = {}) => projectNode(number, { type: 'PULL_REQUEST', status: null, ...overrides })

/** 呼ばれた問い合わせを記録する偽の gh。reply は、何回目の呼び出しに何を返すか。 */
function recorder(reply: (query: string, call: number) => string) {
  const queries: string[] = []
  const run = (args: readonly string[]): string => {
    assert.deepEqual(args.slice(0, 3), ['api', 'graphql', '-f'])
    const query = (args[3] ?? '').replace(/^query=/, '')
    queries.push(query)
    return reply(query, queries.length - 1)
  }
  return { run, queries }
}

describe('offBoardCandidates', () => {
  it('読んだ項目に入っている開いた issue は、候補にしない', () => {
    assert.deepEqual(offBoardCandidates([issue(1), issue(2)], [open(1), open(2)], config), [])
  })

  it('読んだ項目に無い開いた issue が候補になる', () => {
    assert.deepEqual(offBoardCandidates([issue(1)], [open(1), open(2)], config), [open(2)])
  })

  it('B-OFF-BOARD と同じく、除く作者の issue は候補にしない', () => {
    assert.deepEqual(offBoardCandidates([], [open(5, { author: 'external-dev' }), open(6)], config), [open(6)])
  })

  it('リポジトリが違えば、同じ番号でも別の issue として数える', () => {
    const other = 'example-org/app-mobile'
    assert.deepEqual(offBoardCandidates([issue(7)], [open(7), open(7, { repo: other })], config), [open(7, { repo: other })])
  })
})

describe('readQuery', () => {
  it('候補ごとに別名を付けて、リポジトリ、番号、projectItems を 1 つの問い合わせに並べる', () => {
    const query = readQuery([open(8), open(9, { repo: 'example-org/app-mobile' })], config)
    assert.match(query, /c0: repository\(owner:"example-org", name:"app"\)\{ issue\(number:8\)\{ projectItems\(first:20\)/)
    assert.match(query, /c1: repository\(owner:"example-org", name:"app-mobile"\)\{ issue\(number:9\)\{ projectItems\(first:20\)/)
    assert.match(query, /nodes\{ project\{ id \} id type/)
  })

  it('PR の候補は、issue でなく pullRequest として読む。issue と混ぜても、別名は並べた順に付く', () => {
    const query = readQuery([open(8), { ...open(9), isPullRequest: true }, open(10)], config)
    assert.match(query, /c0: repository\(owner:"example-org", name:"app"\)\{ issue\(number:8\)\{ projectItems/)
    assert.match(query, /c1: repository\(owner:"example-org", name:"app"\)\{ pullRequest\(number:9\)\{ projectItems/)
    assert.match(query, /c2: repository\(owner:"example-org", name:"app"\)\{ issue\(number:10\)\{ projectItems/)
  })

  it('ボード全体の問い合わせと同じ欄を読む', () => {
    const fields = /status: fieldValueByName\(name:"Status"\)[\s\S]*content\{ \.\.\. on Issue\{ number title state author\{login\} repository\{nameWithOwner\} \}/
    assert.match(readQuery([open(8)], config), fields)
    assert.match(itemsQuery(config), fields)
  })

  it('リポジトリの名前や番号が読めないものは、問い合わせに入れず投げる', () => {
    assert.throws(() => readQuery([open(1, { repo: 'a b/c' })], config), /指し方が読めない/)
    assert.throws(() => readQuery([open(1, { repo: 'no-slash' })], config), /指し方が読めない/)
    assert.throws(() => readQuery([open(1.5)], config), /指し方が読めない/)
  })
})

describe('readMissingItems', () => {
  it('候補が無ければ、gh を呼ばない', () => {
    const { run, queries } = recorder(() => readResult())
    assert.deepEqual(readMissingItems([issue(1)], [open(1)], config, run), [])
    assert.equal(queries.length, 0)
  })

  it('ボードに入っていた issue を、項目として返す', () => {
    const { run } = recorder(() => readResult([projectNode(8, { status: { name: '作業中' }, tanto: { name: 'SWE1' } })]))
    const [item, ...rest] = readMissingItems([issue(1)], [open(1), open(8)], config, run)
    assert.equal(rest.length, 0)
    assert.equal(item?.itemId, 'PVTI_8')
    assert.equal(item?.number, 8)
    assert.equal(item?.status, '作業中')
    assert.equal(item?.tanto, 'SWE1')
    assert.equal(item?.kind, 'issue')
  })

  it('別のボードにしか入っていない issue は、返さない (ボードに無いのは本当)', () => {
    const { run } = recorder(() => readResult([projectNode(8, { project: { id: 'PVT_other' } })]))
    assert.deepEqual(readMissingItems([], [open(8)], config, run), [])
  })

  it('どのボードにも入っていない issue と、読めない (null の) issue は、返さない', () => {
    const { run } = recorder(() => readResult([], null))
    assert.deepEqual(readMissingItems([], [open(8), open(9)], config, run), [])
  })

  it('複数のボードに入っている issue からは、config のボードの項目だけを返す', () => {
    const { run } = recorder(() => readResult([projectNode(8, { id: 'PVTI_other', project: { id: 'PVT_other' } }), projectNode(8)]))
    assert.deepEqual(readMissingItems([], [open(8)], config, run).map((item) => item.itemId), ['PVTI_8'])
  })

  it('候補が多いときは、READ_BATCH_SIZE ずつに分けて読み、結果をつなげる', () => {
    const numbers = Array.from({ length: READ_BATCH_SIZE * 2 + 10 }, (_, index) => index + 1)
    const { run, queries } = recorder((query) => {
      const aliases = [...query.matchAll(/issue\(number:(\d+)\)/g)].map((one) => Number(one[1]))
      return readResult(...aliases.map((number) => [projectNode(number)]))
    })
    const items = readMissingItems([], numbers.map((number) => open(number)), config, run)
    assert.equal(queries.length, 3)
    assert.deepEqual(queries.map((query) => (query.match(/issue\(number:/g) ?? []).length), [READ_BATCH_SIZE, READ_BATCH_SIZE, 10])
    assert.deepEqual(items.map((item) => item.number), numbers)
  })

  it('1 回にまとめる数は、1 回の問い合わせの費用を抑える上限に収まる (実測: 1 件で 1 点、25 件で 5 点)', () => {
    assert.ok(READ_BATCH_SIZE >= 1 && READ_BATCH_SIZE <= 50, `READ_BATCH_SIZE が ${READ_BATCH_SIZE}`)
  })

  it('読み取りが失敗したら、そのまま投げる (呼ぶ側が控えを書き換えない)', () => {
    const run = () => {
      throw new Error('gh が落ちた')
    }
    assert.throws(() => readMissingItems([], [open(8)], config, run), /gh が落ちた/)
  })

  /** gh が終了コード 1 で終わった形 (execFileSync の例外は、標準出力を stdout に持つ)。 */
  const ghFailed = (stdout: string) => () => {
    throw Object.assign(new Error('gh が exit 1'), { stdout })
  }
  const notFound = { type: 'NOT_FOUND', message: 'Could not resolve to an Issue' }

  it('読んでいる間に消えた issue (NOT_FOUND) があっても、ほかの issue の結果を使う', () => {
    const output = JSON.stringify({ data: { c0: { issue: null }, c1: { issue: { projectItems: { nodes: [projectNode(9)] } } } }, errors: [notFound] })
    const items = readMissingItems([], [open(8), open(9)], config, ghFailed(output))
    assert.deepEqual(items.map((item) => item.number), [9])
  })

  it('NOT_FOUND 以外の失敗が 1 つでも混ざっていれば、そのまま投げる', () => {
    const output = JSON.stringify({ data: { c0: { issue: null } }, errors: [notFound, { type: 'FORBIDDEN', message: 'x' }] })
    assert.throws(() => readMissingItems([], [open(8)], config, ghFailed(output)), /gh が exit 1/)
  })

  it('標準出力が JSON でない、または data が無い失敗は、そのまま投げる', () => {
    assert.throws(() => readMissingItems([], [open(8)], config, ghFailed('rate limit exceeded')), /gh が exit 1/)
    assert.throws(() => readMissingItems([], [open(8)], config, ghFailed(JSON.stringify({ errors: [notFound] }))), /gh が exit 1/)
    assert.throws(() => readMissingItems([], [open(8)], config, ghFailed(JSON.stringify({ data: { c0: null }, errors: [] }))), /gh が exit 1/)
  })

  it('結果に data が無ければ、投げる', () => {
    assert.throws(() => readMissingItems([], [open(8)], config, () => '{"errors":[]}'), /data が無い/)
  })

  it('すでに読んだ項目と同じ itemId のものは、重ねて返さない', () => {
    const { run } = recorder(() => readResult([projectNode(8, { id: 'PVTI_1' })]))
    assert.deepEqual(readMissingItems([issue(1, { number: null })], [open(8)], config, run), [])
  })
})

describe('readMissingItems の開いた PR', () => {
  it('一覧に出ない開いた PR が、実際はボードに入っているなら、PR の項目として返す', () => {
    const { run, queries } = recorder(() => readResultPr([prNode(9)]))
    const [item, ...rest] = readMissingItems([], [], config, run, [open(9)])
    assert.equal(rest.length, 0)
    assert.equal(item?.number, 9)
    assert.equal(item?.kind, 'pr')
    assert.equal(item?.status, null)
    assert.match(queries[0] ?? '', /pullRequest\(number:9\)/)
  })

  it('ボードに入っていない PR と、読めない (null の) PR は、返さない', () => {
    const { run } = recorder(() => readResultPr([], null))
    assert.deepEqual(readMissingItems([], [], config, run, [open(9), open(10)]), [])
  })

  it('別のボードにしか入っていない PR は、返さない', () => {
    const { run } = recorder(() => readResultPr([prNode(9, { project: { id: 'PVT_other' } })]))
    assert.deepEqual(readMissingItems([], [], config, run, [open(9)]), [])
  })

  it('除く作者の PR は、読まない', () => {
    const { run, queries } = recorder(() => readResultPr([prNode(9)]))
    assert.deepEqual(readMissingItems([], [], config, run, [open(9, { author: 'external-dev' })]), [])
    assert.equal(queries.length, 0)
  })

  it('すでに読んだ項目に入っている PR は、読まない (リポジトリが違えば別の PR として数える)', () => {
    const other = 'example-org/app-mobile'
    const { run, queries } = recorder(() => readResultPr([prNode(9, { id: 'PVTI_9_other', content: { number: 9, title: 'x', state: 'OPEN', author: { login: 'owner' }, repository: { nameWithOwner: other } } })]))
    assert.deepEqual(readMissingItems([pr(9)], [], config, run, [open(9)]), [])
    assert.equal(queries.length, 0)
    assert.equal(readMissingItems([pr(9)], [], config, run, [open(9), open(9, { repo: other })]).length, 1)
    assert.equal(queries.length, 1)
  })

  it('issue と PR が混ざった候補を、1 回の問い合わせで読み、それぞれの項目として返す', () => {
    const output = JSON.stringify({
      data: {
        c0: { issue: { projectItems: { nodes: [projectNode(8)] } } },
        c1: { pullRequest: { projectItems: { nodes: [prNode(9)] } } },
      },
    })
    const { run, queries } = recorder(() => output)
    const items = readMissingItems([], [open(8)], config, run, [open(9)])
    assert.equal(queries.length, 1)
    assert.deepEqual(items.map((item) => [item.number, item.kind]), [[8, 'issue'], [9, 'pr']])
  })

  it('PR も、1 回にまとめる数 (READ_BATCH_SIZE) に数えて分ける', () => {
    const numbers = Array.from({ length: READ_BATCH_SIZE + 3 }, (_, index) => index + 1)
    const { run, queries } = recorder((query) => {
      const count = (query.match(/pullRequest\(number:/g) ?? []).length
      return readResultPr(...Array.from({ length: count }, () => []))
    })
    readMissingItems([], [], config, run, numbers.map((number) => open(number)))
    assert.equal(queries.length, 2)
    assert.deepEqual(queries.map((query) => (query.match(/pullRequest\(number:/g) ?? []).length), [READ_BATCH_SIZE, 3])
  })

  it('PR の読み取りが失敗したら、そのまま投げる (呼ぶ側が控えを書き換えない)', () => {
    const run = () => {
      throw new Error('gh が落ちた')
    }
    assert.throws(() => readMissingItems([], [], config, run, [open(9)]), /gh が落ちた/)
  })
})
