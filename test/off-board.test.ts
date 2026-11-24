import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { itemsQuery } from '../src/adapters/github/project-board.ts'
import { offBoardCandidates, READ_BATCH_SIZE, readMissingItems, readQuery } from '../src/adapters/github/off-board.ts'
import type { OpenIssue } from '../src/board/types.ts'
import { config, issue, pr, REPO } from './helpers.ts'

const open = (number: number, overrides: Partial<OpenIssue> = {}): OpenIssue => ({ repo: REPO, number, author: 'owner', ...overrides })

/** One result of reading one issue as an item of the project it belongs to (an item of the config's board). */
function projectNode(number: number, overrides: Record<string, unknown> = {}) {
  return {
    project: { id: config.projectId },
    id: `PVTI_${number}`,
    type: 'ISSUE',
    status: { name: 'Next' },
    content: { number, title: `issue ${number}`, state: 'OPEN', author: { login: 'owner' }, repository: { nameWithOwner: REPO } },
    ...overrides,
  }
}

/** Output of the graphql that reads one issue at a time: for each alias c0, c1, ..., the list of projectItems nodes. null is a shape where the issue cannot be read. */
function readResult(...perIssue: readonly (readonly unknown[] | null)[]): string {
  return JSON.stringify({
    data: Object.fromEntries(perIssue.map((nodes, index) => [`c${index}`, nodes === null ? null : { issue: { projectItems: { nodes } } }])),
  })
}

/** The read result for PRs. For each alias c0, c1, ..., the list of projectItems nodes (a PR sits under pullRequest). */
function readResultPr(...perPr: readonly (readonly unknown[] | null)[]): string {
  return JSON.stringify({
    data: Object.fromEntries(perPr.map((nodes, index) => [`c${index}`, nodes === null ? null : { pullRequest: { projectItems: { nodes } } }])),
  })
}

/** One result of reading one PR as an item of the project it belongs to. */
const prNode = (number: number, overrides: Record<string, unknown> = {}) => projectNode(number, { type: 'PULL_REQUEST', status: null, ...overrides })

/** A fake gh that records the queries it is called with. reply says what to return for which call. */
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
  it('does not make a candidate of an open issue that is among the items read', () => {
    assert.deepEqual(offBoardCandidates([issue(1), issue(2)], [open(1), open(2)], config), [])
  })

  it('an open issue that is not among the items read becomes a candidate', () => {
    assert.deepEqual(offBoardCandidates([issue(1)], [open(1), open(2)], config), [open(2)])
  })

  it('as with B-OFF-BOARD, does not make a candidate of an issue by an excluded author', () => {
    assert.deepEqual(offBoardCandidates([], [open(5, { author: 'external-dev' }), open(6)], config), [open(6)])
  })

  it('with a different repository, the same number counts as a different issue', () => {
    const other = 'example-org/app-mobile'
    assert.deepEqual(offBoardCandidates([issue(7)], [open(7), open(7, { repo: other })], config), [open(7, { repo: other })])
  })
})

describe('readQuery', () => {
  it('gives each candidate an alias and lines up the repository, number, and projectItems in one query', () => {
    const query = readQuery([open(8), open(9, { repo: 'example-org/app-mobile' })], config)
    assert.match(query, /c0: repository\(owner:"example-org", name:"app"\)\{ issue\(number:8\)\{ projectItems\(first:20\)/)
    assert.match(query, /c1: repository\(owner:"example-org", name:"app-mobile"\)\{ issue\(number:9\)\{ projectItems\(first:20\)/)
    assert.match(query, /nodes\{ project\{ id \} id type/)
  })

  it('a PR candidate is read as pullRequest, not issue; even mixed with issues, aliases are assigned in the order lined up', () => {
    const query = readQuery([open(8), { ...open(9), isPullRequest: true }, open(10)], config)
    assert.match(query, /c0: repository\(owner:"example-org", name:"app"\)\{ issue\(number:8\)\{ projectItems/)
    assert.match(query, /c1: repository\(owner:"example-org", name:"app"\)\{ pullRequest\(number:9\)\{ projectItems/)
    assert.match(query, /c2: repository\(owner:"example-org", name:"app"\)\{ issue\(number:10\)\{ projectItems/)
  })

  it('reads the same fields as the whole-board query', () => {
    const fields = /status: fieldValueByName\(name:"Status"\)[\s\S]*content\{ \.\.\. on Issue\{ number title state author\{login\} repository\{nameWithOwner\} \}/
    assert.match(readQuery([open(8)], config), fields)
    assert.match(itemsQuery(config), fields)
  })

  it('throws instead of putting into the query an entry whose repository name or number cannot be read', () => {
    assert.throws(() => readQuery([open(1, { repo: 'a b/c' })], config), /cannot read how the open issue is referenced/)
    assert.throws(() => readQuery([open(1, { repo: 'no-slash' })], config), /cannot read how the open issue is referenced/)
    assert.throws(() => readQuery([open(1.5)], config), /cannot read how the open issue is referenced/)
  })
})

describe('readMissingItems', () => {
  it('does not call gh when there are no candidates', () => {
    const { run, queries } = recorder(() => readResult())
    assert.deepEqual(readMissingItems([issue(1)], [open(1)], config, run), [])
    assert.equal(queries.length, 0)
  })

  it('returns an issue that was on the board as an item', () => {
    const { run } = recorder(() => readResult([projectNode(8, { status: { name: 'In Progress' }, assignee: { name: 'SWE1' } })]))
    const [item, ...rest] = readMissingItems([issue(1)], [open(1), open(8)], config, run)
    assert.equal(rest.length, 0)
    assert.equal(item?.itemId, 'PVTI_8')
    assert.equal(item?.number, 8)
    assert.equal(item?.status, 'In Progress')
    assert.equal(item?.assignee, 'SWE1')
    assert.equal(item?.kind, 'issue')
  })

  it('does not return an issue that is only on another board (it is truly not on the board)', () => {
    const { run } = recorder(() => readResult([projectNode(8, { project: { id: 'PVT_other' } })]))
    assert.deepEqual(readMissingItems([], [open(8)], config, run), [])
  })

  it('does not return an issue that is on no board or an unreadable (null) issue', () => {
    const { run } = recorder(() => readResult([], null))
    assert.deepEqual(readMissingItems([], [open(8), open(9)], config, run), [])
  })

  it("for an issue on several boards, returns only the item of the config's board", () => {
    const { run } = recorder(() => readResult([projectNode(8, { id: 'PVTI_other', project: { id: 'PVT_other' } }), projectNode(8)]))
    assert.deepEqual(readMissingItems([], [open(8)], config, run).map((item) => item.itemId), ['PVTI_8'])
  })

  it('when there are many candidates, reads them in groups of READ_BATCH_SIZE and joins the results', () => {
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

  it('the number batched into one call stays within the limit that keeps the cost of one query down (measured: 1 item costs 1 point, 25 items cost 5 points)', () => {
    assert.ok(READ_BATCH_SIZE >= 1 && READ_BATCH_SIZE <= 50, `READ_BATCH_SIZE is ${READ_BATCH_SIZE}`)
  })

  it('when the read fails, throws as is (so the caller does not rewrite the board copy)', () => {
    const run = () => {
      throw new Error('gh crashed')
    }
    assert.throws(() => readMissingItems([], [open(8)], config, run), /gh crashed/)
  })

  /** The shape of gh exiting with code 1 (the exception from execFileSync carries standard output in stdout). */
  const ghFailed = (stdout: string) => () => {
    throw Object.assign(new Error('gh exited with 1'), { stdout })
  }
  const notFound = { type: 'NOT_FOUND', message: 'Could not resolve to an Issue' }

  it('even if an issue that disappeared during the read (NOT_FOUND) exists, uses the results for the other issues', () => {
    const output = JSON.stringify({ data: { c0: { issue: null }, c1: { issue: { projectItems: { nodes: [projectNode(9)] } } } }, errors: [notFound] })
    const items = readMissingItems([], [open(8), open(9)], config, ghFailed(output))
    assert.deepEqual(items.map((item) => item.number), [9])
  })

  it('throws as is when even one failure other than NOT_FOUND is mixed in', () => {
    const output = JSON.stringify({ data: { c0: { issue: null } }, errors: [notFound, { type: 'FORBIDDEN', message: 'x' }] })
    assert.throws(() => readMissingItems([], [open(8)], config, ghFailed(output)), /gh exited with 1/)
  })

  it('throws as is for a failure whose standard output is not JSON or has no data', () => {
    assert.throws(() => readMissingItems([], [open(8)], config, ghFailed('rate limit exceeded')), /gh exited with 1/)
    assert.throws(() => readMissingItems([], [open(8)], config, ghFailed(JSON.stringify({ errors: [notFound] }))), /gh exited with 1/)
    assert.throws(() => readMissingItems([], [open(8)], config, ghFailed(JSON.stringify({ data: { c0: null }, errors: [] }))), /gh exited with 1/)
  })

  it('throws when the result has no data', () => {
    assert.throws(() => readMissingItems([], [open(8)], config, () => '{"errors":[]}'), /has no data/)
  })

  it('does not return again an item with the same itemId as one already read', () => {
    const { run } = recorder(() => readResult([projectNode(8, { id: 'PVTI_1' })]))
    assert.deepEqual(readMissingItems([issue(1, { number: null })], [open(8)], config, run), [])
  })
})

describe('open PRs of readMissingItems', () => {
  it('when an open PR missing from the list is actually on the board, returns it as a PR item', () => {
    const { run, queries } = recorder(() => readResultPr([prNode(9)]))
    const [item, ...rest] = readMissingItems([], [], config, run, [open(9)])
    assert.equal(rest.length, 0)
    assert.equal(item?.number, 9)
    assert.equal(item?.kind, 'pr')
    assert.equal(item?.status, null)
    assert.match(queries[0] ?? '', /pullRequest\(number:9\)/)
  })

  it('does not return a PR that is not on the board or an unreadable (null) PR', () => {
    const { run } = recorder(() => readResultPr([], null))
    assert.deepEqual(readMissingItems([], [], config, run, [open(9), open(10)]), [])
  })

  it('does not return a PR that is only on another board', () => {
    const { run } = recorder(() => readResultPr([prNode(9, { project: { id: 'PVT_other' } })]))
    assert.deepEqual(readMissingItems([], [], config, run, [open(9)]), [])
  })

  it('does not read PRs by excluded authors', () => {
    const { run, queries } = recorder(() => readResultPr([prNode(9)]))
    assert.deepEqual(readMissingItems([], [], config, run, [open(9, { author: 'external-dev' })]), [])
    assert.equal(queries.length, 0)
  })

  it('does not read a PR that is already among the items read (with a different repository it counts as a different PR)', () => {
    const other = 'example-org/app-mobile'
    const { run, queries } = recorder(() => readResultPr([prNode(9, { id: 'PVTI_9_other', content: { number: 9, title: 'x', state: 'OPEN', author: { login: 'owner' }, repository: { nameWithOwner: other } } })]))
    assert.deepEqual(readMissingItems([pr(9)], [], config, run, [open(9)]), [])
    assert.equal(queries.length, 0)
    assert.equal(readMissingItems([pr(9)], [], config, run, [open(9), open(9, { repo: other })]).length, 1)
    assert.equal(queries.length, 1)
  })

  it('reads a candidate list mixing issues and PRs in one query and returns each as its own item', () => {
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

  it('PRs also count toward the batch size (READ_BATCH_SIZE) and are split', () => {
    const numbers = Array.from({ length: READ_BATCH_SIZE + 3 }, (_, index) => index + 1)
    const { run, queries } = recorder((query) => {
      const count = (query.match(/pullRequest\(number:/g) ?? []).length
      return readResultPr(...Array.from({ length: count }, () => []))
    })
    readMissingItems([], [], config, run, numbers.map((number) => open(number)))
    assert.equal(queries.length, 2)
    assert.deepEqual(queries.map((query) => (query.match(/pullRequest\(number:/g) ?? []).length), [READ_BATCH_SIZE, 3])
  })

  it('when reading PRs fails, throws as is (so the caller does not rewrite the board copy)', () => {
    const run = () => {
      throw new Error('gh crashed')
    }
    assert.throws(() => readMissingItems([], [], config, run, [open(9)]), /gh crashed/)
  })
})
