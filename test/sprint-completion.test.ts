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

/** Re-fetches through the GitHub adapter. gh is answered by a fake placed at the front of PATH for each test. */
const refreshSnapshot = (p: Paths, c: Config, now: Date) => refreshWith(p, c, now, projectBoardSource(gh, c))

const config: Config = {
  ...base,
  sprint: { checkpoints: ['08:00', '13:00', '21:00'], utcOffset: '+09:00', pointsField: 'Story points', overrunField: 'Overrun', pointBudgets: { '1': 1, '2': 1, '3': 2, '5': 3, '8': 5 } },
}
const jst = (text: string) => new Date(`${text}+09:00`)
/** Entered In Progress on 10/29 09:00 and finished on 10/30 14:00. The checkpoints crossed are four: 13:00, 21:00, 08:00, and 13:00 */
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
  it('returns an issue that was In Progress in the previous board copy and is Done or in Release in the current one', () => {
    const previous = snapshot([doingBefore(1), doingBefore(2), doingBefore(3)])
    const fresh = snapshot([finished(1, config.statuses.done), finished(2, config.statuses.release), doingBefore(3)])
    assert.deepEqual(newlyFinished(previous, fresh, config).map((pair) => pair.item.number), [1, 2])
  })

  it('returns nothing for an issue that was not In Progress in the previous board copy (Backlog straight to Done), or when there is no previous board copy', () => {
    const previous = snapshot([issue(1, { status: config.statuses.backlog })])
    const fresh = snapshot([finished(1, config.statuses.done)])
    assert.deepEqual(newlyFinished(previous, fresh, config), [])
    assert.deepEqual(newlyFinished(null, fresh, config), [])
  })

  it('does not return an issue that stays In Progress, one moved back to Next, an issue by an excluded author, or a PR', () => {
    const previous = snapshot([doingBefore(1), doingBefore(2, { author: 'external-dev' }), doingBefore(3)])
    const fresh = snapshot([issue(1, { status: config.statuses.next }), finished(2, config.statuses.done, { author: 'external-dev' }), finished(3, config.statuses.done, { kind: 'pr' })])
    assert.deepEqual(newlyFinished(previous, fresh, config), [])
  })
})

describe('recordCompletions', () => {
  const previous = snapshot([doingBefore(1)])
  const fresh = snapshot([finished(1, config.statuses.done)])

  it('counts points, budget, and checkpoints taken from the record of Status changes, and keeps one line per issue', () => {
    const p = setup()
    const found = recordCompletions(p, previous, fresh, config, NOW, () => new Map([['app#1', timeline(config.statuses.done)]]))
    assert.deepEqual(found, [{ label: 'app#1', points: 3, budget: 2, effort: 4, detectedAt: NOW.toISOString(), status: config.statuses.done, exact: true }])
    assert.deepEqual(loadCompletions(p), found)
  })

  it('a checkpoint during which the team was stalled does not count toward the checkpoints taken (the stall in the checkpoint record)', () => {
    const p = setup()
    const records = [{ scheduledFor: jst('2026-10-29T21:00:00').toISOString(), recordedAt: jst('2026-10-29T21:01:00').toISOString(), items: [{ label: 'app#1', points: 3, budget: 2, effort: 2, over: 0, reason: 'Needs decision', assignee: null }] }]
    appendLine(p.checkpoints, JSON.stringify(records[0]))
    const [one] = recordCompletions(p, previous, fresh, config, NOW, () => new Map([['app#1', timeline(config.statuses.done)]]))
    assert.equal(one?.effort, 3)
  })

  it("when Status changes cannot be read, counts by adding the finish time to the previous board copy's record, and marks the result as approximate", () => {
    const p = setup()
    const [one] = recordCompletions(p, previous, fresh, config, NOW, () => null)
    assert.equal(one?.effort, 4)
    assert.equal(one?.exact, false)
  })

  it('when the previous board copy has no record either, keeps the checkpoints taken as null (unknown)', () => {
    const p = setup()
    const [one] = recordCompletions(p, snapshot([doingBefore(1, { statusEvents: undefined })]), fresh, config, NOW, () => null)
    assert.equal(one?.effort, null)
    assert.equal(one?.points, 3)
  })

  it('keeps an issue in Release as finished too', () => {
    const p = setup()
    const [one] = recordCompletions(p, previous, snapshot([finished(1, config.statuses.release)]), config, NOW, () => new Map([['app#1', timeline(config.statuses.release)]]))
    assert.equal(one?.status, config.statuses.release)
  })

  it('an issue that moved back and forth between In Progress and Done is recorded again when it finishes once more (if the record is not newer than the previous board copy, it is not a redo)', () => {
    const p = setup()
    const earlier = { label: 'app#1', points: 3, budget: 2, effort: 1, detectedAt: '2026-10-07T00:00:00.000Z', status: config.statuses.done, exact: true }
    appendLine(p.completions, JSON.stringify(earlier))
    const found = recordCompletions(p, previous, fresh, config, NOW, () => new Map([['app#1', timeline(config.statuses.done)]]))
    assert.deepEqual(found.map((one) => one.label), ['app#1'])
    assert.deepEqual(loadCompletions(p).map((one) => one.detectedAt), [earlier.detectedAt, NOW.toISOString()])
  })

  it('does nothing when there is no sprint config; when nothing finished, does not read Status changes either', () => {
    const p = setup()
    assert.deepEqual(recordCompletions(p, previous, fresh, base, NOW, () => assert.fail('do not read')), [])
    let called = 0
    recordCompletions(p, snapshot([doingBefore(1)]), snapshot([doingBefore(1)]), config, NOW, () => {
      called += 1
      return null
    })
    assert.equal(called, 0)
    assert.equal(readText(p.completions), '')
  })

  it('skips lines that cannot be read and returns the ones that can', () => {
    const p = setup()
    appendLine(p.completions, 'not json')
    appendLine(p.completions, JSON.stringify({ label: 'app#9', points: 1, budget: 1, effort: 0, detectedAt: NOW.toISOString(), status: 'Done', exact: true }))
    assert.deepEqual(loadCompletions(p).map((one) => one.label), ['app#9'])
  })
})

describe('refreshSnapshot records finished issues', () => {
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

  it('after writing the board copy, records one issue that went from In Progress to Done (approximated from the previous board copy even if Status changes cannot be read)', () => {
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

  it('even when recording fails, the board copy is written and the re-fetch stays successful; the failure is left in errors.log', () => {
    const p = setup()
    writeJson(p.snapshot, snapshot([issue(1, { status: config.statuses.doing, points: 3, repo: 'example-org/app', statusEvents: [{ at: START.toISOString(), status: config.statuses.doing }] })]))
    mkdirSync(p.completions, { recursive: true })
    withGh(page(config.statuses.done), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    assert.equal(JSON.parse(readFileSync(p.snapshot, 'utf8')).items[0].status, config.statuses.done)
    assert.match(readFileSync(p.errors, 'utf8'), /completions: /)
  })

  it('compares against the board copy last obtained by a re-fetch (In Progress), not the board copy a hook wrote after fixing Status (Done), and records', () => {
    const p = setup()
    writeJson(p.fetchedSnapshot, snapshot([doingItem(1)]))
    // A board copy where, after the script that rewrites Status, the hook set Status to Done and wrote it
    writeJson(p.snapshot, snapshot([{ ...doingItem(1), status: config.statuses.done }]))
    withGh(page(config.statuses.done), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    assert.deepEqual(loadCompletions(p).map((one) => one.label), ['app#1'])
    assert.equal(loadFetchedSnapshot(p)?.items[0]?.status, config.statuses.done)
  })

  it('when there is no last-obtained board copy (the first re-fetch), compares with the current board copy', () => {
    const p = setup()
    writeJson(p.snapshot, snapshot([doingItem(1)]))
    withGh(page(config.statuses.done), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    assert.deepEqual(loadCompletions(p).map((one) => one.label), ['app#1'])
    assert.equal(loadFetchedSnapshot(p)?.items[0]?.status, config.statuses.done)
  })

  it('when recording fails, does not advance the last-obtained board copy; the next re-fetch finds the same issue again and records it', () => {
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

  it('when recording fails midway and is retried, an issue that was already recorded is not recorded again', () => {
    const p = setup()
    writeJson(p.fetchedSnapshot, snapshot([doingItem(1), doingItem(2)]))
    appendLine(p.completions, JSON.stringify({ label: 'app#1', points: 3, budget: 2, effort: 4, detectedAt: NOW.toISOString(), status: config.statuses.done, exact: true }))
    withGh(pageOfItems([[1, config.statuses.done], [2, config.statuses.done]]), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    assert.deepEqual(loadCompletions(p).map((one) => one.label), ['app#1', 'app#2'])
  })

  it('records nothing while the issue stays In Progress', () => {
    const p = setup()
    writeJson(p.snapshot, snapshot([issue(1, { status: config.statuses.doing, points: 3, repo: 'example-org/app' })]))
    withGh(page(config.statuses.doing), () => {
      assert.notEqual(refreshSnapshot(p, oneRepo, NOW), null)
    })
    assert.deepEqual(loadCompletions(p), [])
  })
})

describe('display of estimate versus actual for finished issues', () => {
  const one = (label: string, points: number | null, budget: number | null, effort: number | null, detectedAt: string, exact = true): Completion => ({
    label,
    points,
    budget,
    effort,
    detectedAt,
    status: 'Done',
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

  it('lists finished issues newest first and marks approximate ones; shows - for those whose points or checkpoints are unknown', () => {
    const lines = formatCompletions(data)
    const rows = lines.slice(lines.indexOf('issue\tpoints\tbudget\tcheckpoints taken\tnote') + 1, lines.indexOf('Estimate versus actual by points (median and range of checkpoints taken)') - 1)
    assert.deepEqual(rows, ['app#6\t-\t-\t1\t', 'app#5\t2\t1\t-\t', 'app#4\t5\t3\t3\t', 'app#3\t3\t2\t0\tapprox.', 'app#2\t3\t2\t2\t', 'app#1\t3\t2\t4\t'])
  })

  it('for each point value, shows the count, the median and range of checkpoints taken, and the count that exceeded the budget; does not count those whose points or checkpoints are unknown', () => {
    const lines = formatCompletions(data)
    assert.deepEqual(lines.slice(lines.indexOf('points\tbudget\tcount\tmedian\trange\tover budget') + 1), ['3\t2\t3\t2\t0-4\t1', '5\t3\t1\t3\t3-3\t0'])
  })

  it('when the count is even, shows the average of the middle two (1 decimal place)', () => {
    const lines = formatCompletions([one('a#1', 3, 2, 1, '2026-10-30T01:00:00Z'), one('a#2', 3, 2, 2, '2026-10-30T02:00:00Z')])
    assert.equal(lines.at(-1), '3\t2\t2\t1.5\t1-2\t0')
  })

  it('when one issue has several records (it went back and forth), uses only the newest, both in the list and per point value', () => {
    const lines = formatCompletions([
      one('app#7', 3, 2, 1, '2026-10-30T01:00:00Z'),
      one('app#7', 3, 2, 3, '2026-10-30T09:00:00Z'),
      one('app#8', 3, 2, 0, '2026-10-30T05:00:00Z'),
    ])
    const rows = lines.slice(lines.indexOf('issue\tpoints\tbudget\tcheckpoints taken\tnote') + 1, lines.indexOf('Estimate versus actual by points (median and range of checkpoints taken)') - 1)
    assert.deepEqual(rows, ['app#7\t3\t2\t3\t', 'app#8\t3\t2\t0\t'])
    assert.equal(lines.at(-1), '3\t2\t2\t1.5\t0-3\t1')
  })

  it('shows nothing when there are no records; the newest-first list is capped at 20 entries', () => {
    assert.deepEqual(formatCompletions([]), [])
    const many = Array.from({ length: 25 }, (_, index) => one(`a#${index}`, 1, 1, 0, `2026-10-30T${String(index).padStart(2, '0')}:00:00Z`))
    const lines = formatCompletions(many)
    const rows = lines.slice(lines.indexOf('issue\tpoints\tbudget\tcheckpoints taken\tnote') + 1, lines.indexOf('Estimate versus actual by points (median and range of checkpoints taken)') - 1)
    assert.equal(rows.length, 20)
    assert.equal(rows[0]?.startsWith('a#24\t'), true)
    assert.equal(lines.at(-1), '1\t1\t25\t0\t0-0\t0')
  })

  it('appears below the scrum points table; when there are no records, the table is unchanged', () => {
    const snap = snapshot([])
    const without = formatPoints(snap, historyOf(), config, NOW)
    assert.equal(without.includes('Estimate versus actual of finished issues'), false)
    const withData = formatPoints(snap, historyOf(), config, NOW, data)
    assert.equal(withData.startsWith(without), true)
    assert.equal(withData.includes('Estimate versus actual of finished issues'), true)
  })
})
