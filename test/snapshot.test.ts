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

/** Re-fetches through the GitHub adapter. gh is answered by a fake placed at the front of PATH for each test. */
const refreshSnapshot = (p: Paths, c: Config, now: Date) => refreshWith(p, c, now, projectBoardSource(gh, c))

const page = JSON.parse(readFileSync(new URL('./fixtures/graphql-page.json', import.meta.url), 'utf8'))

/** One fetch result for an issue item that has content. */
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

/** One page of a fixture that carries the total item count (totalCount), as a real fetch result does. */
const fixturePage = structuredClone(page)
fixturePage.data.node.items.totalCount = fixturePage.data.node.items.nodes.length

const unreadable = (number: number) => node(number, { content: null })

describe('parseItemPages', () => {
  it('extracts items from a slurped array of pages', () => {
    const items = parseItemPages(JSON.stringify([fixturePage]))
    assert.equal(items.length, 4)
    assert.equal(items[0]?.number, 101)
  })

  it('joins the items of several pages', () => {
    const items = parseItemPages(JSON.stringify([pageOf([node(1), node(2)], 3), pageOf([node(3)], 3)]))
    assert.deepEqual(items.map((item) => item.number), [1, 2, 3])
  })

  it('throws for a one-page object that was not slurped, since it is not an array of pages', () => {
    assert.throws(() => parseItemPages(JSON.stringify(page)), /is not an array of pages/)
  })

  it('throws for an empty array', () => {
    assert.throws(() => parseItemPages('[]'), /is not an array of pages/)
  })

  it('throws for a page whose node is null (when permission is lacking), noting which page it was', () => {
    const broken = { data: { node: null }, errors: [{ message: 'Could not resolve to a node' }] }
    assert.throws(() => parseItemPages(JSON.stringify([pageOf([node(1)], 2), broken])), /Page 2 of the board fetch result has no list of items/)
  })

  it('throws for a result that fetched slightly fewer items than the total (a page was cut off midway)', () => {
    const firstThree = Array.from({ length: 300 }, (_, i) => node(i + 1))
    assert.throws(() => parseItemPages(JSON.stringify([pageOf(firstThree, 500)])), /Only 300 of 500 board items were fetched/)
  })

  it('passes a difference of only a few items having disappeared from the board during the fetch', () => {
    const nodes = Array.from({ length: 997 }, (_, i) => node(i + 1))
    assert.equal(parseItemPages(JSON.stringify([pageOf(nodes, 1000)])).length, 997)
  })

  it('throws for a result with no total (totalCount), since it cannot be cross-checked', () => {
    const noTotal = { data: { node: { items: { nodes: [node(1)] } } } }
    assert.throws(() => parseItemPages(JSON.stringify([noTotal])), /totalCount/)
  })

  it('throws when there are 0 items, so the board copy is not rewritten', () => {
    assert.throws(() => parseItemPages(JSON.stringify([pageOf([])])), /The board has 0 items/)
  })

  it('throws when more than half of the issue and PR items have unreadable content', () => {
    const nodes = [...Array.from({ length: 4 }, (_, i) => node(i + 1)), ...Array.from({ length: 8 }, (_, i) => unreadable(i + 100))]
    assert.throws(() => parseItemPages(JSON.stringify([pageOf(nodes)])), /The content of 8 of \d+ issue and PR items cannot be read/)
  })

  it('passes when half or fewer of the items have unreadable content', () => {
    const nodes = [...Array.from({ length: 8 }, (_, i) => node(i + 1)), ...Array.from({ length: 4 }, (_, i) => unreadable(i + 100))]
    assert.equal(parseItemPages(JSON.stringify([pageOf(nodes)])).length, 12)
  })

  it('does not look at the ratio of unreadable items on a board with few items', () => {
    const nodes = [node(1), unreadable(2), unreadable(3)]
    assert.equal(parseItemPages(JSON.stringify([pageOf(nodes)])).length, 3)
  })

  it('does not count a draft as an unreadable item, since having no content is normal for it', () => {
    const drafts = Array.from({ length: 12 }, (_, i) => ({ id: `PVTI_d${i}`, type: 'DRAFT_ISSUE', content: { title: `draft ${i}` } }))
    assert.equal(parseItemPages(JSON.stringify([pageOf([node(1), ...drafts])])).length, 13)
  })
})

describe('refreshSnapshot protects the previous board copy when the fetch is broken', () => {
  type FakeGhOptions = {
    /** Output of gh issue list (the same for every repository). */
    readonly issues?: string
    /** Output of gh pr list (the same for every repository). */
    readonly prs?: string
    /** If true, gh pr list fails. */
    readonly prsFail?: boolean
    /** Output of the graphql that reads board items one at a time (an api call without --paginate). */
    readonly read?: string
    /** If true, the graphql that reads one at a time fails. */
    readonly readFails?: boolean
  }

  /** Puts a fake gh at the front of PATH and decides the output of the graphql that reads pages, the graphql that reads one at a time, and issue list. */
  function withFakeGh(graphqlOutput: string, run: () => void, options: FakeGhOptions = {}): void {
    const { issues = '[{"number":7,"author":{"login":"owner"}}]', prs = '[]', prsFail = false, read = '{"data":{}}', readFails = false } = options
    const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
    const readBranch = readFails ? `echo 'read failed' >&2; exit 1` : `printf '%s' '${read}'`
    const prBranch = prsFail ? `echo 'pr list failed' >&2; exit 1` : `printf '%s' '${prs}'`
    /** issue list and pr list answer only when called with the arguments that read up to 1000 open items (they fail if the arguments change). */
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

  it('with a fetch result of 0 items, does not rewrite the board copy and leaves a record in errors.log', () => {
    const { p, previous } = setup()
    withFakeGh(JSON.stringify([pageOf([])]), () => {
      assert.equal(refreshSnapshot(p, config, new Date('2026-10-23T00:00:00Z')), null)
    })
    assert.deepEqual(JSON.parse(readFileSync(p.snapshot, 'utf8')), previous)
    assert.match(readFileSync(p.errors, 'utf8'), /refresh: The board has 0 items/)
  })

  it('with a result that fetched slightly fewer items than the total, does not rewrite the board copy and leaves a record in errors.log', () => {
    const { p, previous } = setup()
    const truncated = pageOf(Array.from({ length: 300 }, (_, i) => node(i + 1)), 500)
    withFakeGh(JSON.stringify([truncated]), () => {
      assert.equal(refreshSnapshot(p, config, new Date('2026-10-23T00:00:00Z')), null)
    })
    assert.deepEqual(JSON.parse(readFileSync(p.snapshot, 'utf8')), previous)
    assert.match(readFileSync(p.errors, 'utf8'), /Only 300 of 500 board items were fetched/)
  })

  it('with a valid fetch result, rewrites the board copy', () => {
    const { p } = setup()
    withFakeGh(JSON.stringify([pageOf([node(7), node(8)])]), () => {
      const fresh = refreshSnapshot(p, config, new Date('2026-10-23T00:00:00Z'))
      assert.equal(fresh?.items.length, 2)
      assert.equal(fresh?.openIssues.length, config.repos.length)
    })
    assert.equal(JSON.parse(readFileSync(p.snapshot, 'utf8')).items.length, 2)
  })

  describe('items that are on the board but missing from the page list', () => {
    const now = new Date('2026-11-05T00:00:00Z')
    const oneRepo = { ...config, repos: ['example-org/app'] }
    const issues = '[{"number":7,"author":{"login":"owner"}},{"number":8,"author":{"login":"owner"}}]'
    /** Only #7 appears in the page list (the total is 2, a shape within the allowed shortfall of a few items. The top-up reads, one at a time, whatever is missing from the list, regardless of the total). */
    const pagedWithoutEight = JSON.stringify([pageOf([node(7)], 2)])
    const readResult = (nodes: readonly unknown[]) => JSON.stringify({ data: { c0: { issue: { projectItems: { nodes } } } } })
    const offBoard = (found: ReturnType<typeof refreshSnapshot>) => (found === null ? [] : lintBoard(found, oneRepo, now)).filter((one) => one.rule === 'B-OFF-BOARD')

    it('when an open issue missing from the list is actually on the board, reads it one at a time, adds it to the board copy, and does not emit B-OFF-BOARD', () => {
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

    it('an issue that is still not on the board after reading one at a time is not added, and B-OFF-BOARD is emitted', () => {
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

    it('when reading one at a time fails, does not rewrite the board copy and leaves a record in errors.log (so it does not write a copy with items missing and wrongly report them)', () => {
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

    it('when the list has no gaps, does not read one at a time (even with a gh whose reads fail, the board copy can be written)', () => {
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

  describe('open PRs that are on the board but missing from the page list', () => {
    const now = new Date('2026-11-05T00:00:00Z')
    const oneRepo = { ...config, repos: ['example-org/app'] }
    const issues = '[{"number":7,"author":{"login":"owner"}}]'
    const prs = '[{"number":9,"author":{"login":"owner"}}]'
    const pagedWithoutNine = JSON.stringify([pageOf([node(7)], 1)])
    const prNode = (overrides: Record<string, unknown> = {}) => ({
      ...node(9, { type: 'PULL_REQUEST', status: null, ...overrides }),
      project: { id: config.projectId },
    })
    /** Output of the one-at-a-time graphql that returns the list of projectItems nodes for the PR under alias c0. */
    const prReadResult = (nodes: readonly unknown[]) => JSON.stringify({ data: { c0: { pullRequest: { projectItems: { nodes } } } } })
    const findings = (found: ReturnType<typeof refreshSnapshot>, rule: string) =>
      (found === null ? [] : lintBoard(found, oneRepo, now)).filter((one) => one.rule === rule)

    it("when it is actually on the board, reads it one at a time and adds it to the board copy; the guard before writes blocks a Status on that PR's number", () => {
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

    it('when a PR with a Status is added, B-PR-STATUS is emitted', () => {
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

    it("a PR does not go into the board copy's open issues; B-OFF-BOARD is emitted for neither an added PR nor one that was not added", () => {
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

    it('a PR that is still not on the board after reading one at a time is not added', () => {
      const { p } = setup()
      withFakeGh(
        pagedWithoutNine,
        () => {
          assert.deepEqual(refreshSnapshot(p, oneRepo, now)?.items.map((item) => item.number), [7])
        },
        { issues, prs, read: prReadResult([]) },
      )
    })

    it('when gh pr list fails, does not rewrite the board copy and leaves a record in errors.log', () => {
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

    it('a PR that is in the list is written to the board copy without being read, even with a gh whose reads fail', () => {
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

  it('when the fetch fails, leaves the output of gh as is in the log (so the cause can be investigated the next time it happens)', () => {
    const { p } = setup()
    const truncated = JSON.stringify([pageOf(Array.from({ length: 40 }, (_, i) => node(i + 1)), 500)])
    withFakeGh(truncated, () => {
      refreshSnapshot(p, config, new Date('2026-10-23T00:00:00Z'))
    })
    const saved = readdirSync(join(p.dir, 'log')).filter((name) => name.startsWith('fetch-failed-'))
    assert.equal(saved.length, 1)
    assert.equal(readFileSync(join(p.dir, 'log', saved[0] ?? ''), 'utf8'), truncated)
  })

  it('keeps only the newest 5 failure records', () => {
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

  it('even if the board copy is stale, does not re-fetch until refreshSeconds has passed since the last attempt (so repeated failures do not use up the limit)', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-')))
    writeJson(p.snapshot, { ...snapshot([issue(7)]), fetchedAt: '2026-10-22T00:00:00Z' })
    withFakeGhStatic(JSON.stringify([pageOf([])]), () => refreshSnapshot(p, config, t0))
    assert.equal(isRefreshDue(p, config, after(60)), false)
    assert.equal(isRefreshDue(p, config, after(config.refreshSeconds + 1)), true)
  })

  it('when there is no board copy, re-fetches unless an attempt has been made', () => {
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
