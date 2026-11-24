import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config.ts'
import { parseConfig } from '../src/config.ts'
import { normalizeNodes } from '../src/adapters/github/item-node.ts'
import { parseStatusHistory, statusHistoryQuery, withStatusHistory } from '../src/adapters/github/status-history.ts'
import { gh } from '../src/adapters/github/gh.ts'
import { planMarks } from '../src/sprint/marks.ts'
import { recordDueCheckpoint } from '../src/sprint/checkpoint-run.ts'
import { loadRecords } from '../src/sprint/record.ts'
import { paths } from '../src/store.ts'
import { config as base, issue, pr, snapshot } from './helpers.ts'

const sprint = {
  checkpoints: ['08:00', '13:00', '21:00'],
  utcOffset: '+09:00',
  pointsField: 'Story points',
  overrunField: 'Overrun',
  pointBudgets: { '1': 1, '2': 1, '3': 2, '5': 3, '8': 5 },
}
const config: Config = { ...base, sprint }
const jst = (text: string) => new Date(`${text}+09:00`)

describe('sprint of parseConfig', () => {
  it('uses it when complete', () => {
    assert.deepEqual(parseConfig({ ...base, sprint })?.sprint, sprint)
  })

  it('when missing or the wrong shape, drops only sprint and uses the rest', () => {
    const broken = parseConfig({ ...base, sprint: { ...sprint, utcOffset: 'JST' } })
    assert.equal(broken?.sprint, undefined)
    assert.equal(broken?.techlead, 'TechLead')
    assert.equal(parseConfig({ ...base, sprint: { ...sprint, checkpoints: ['8am'] } })?.sprint, undefined)
  })
})

describe('extracting the points and overrun fields', () => {
  it('reads the value of a Number field', () => {
    const [item] = normalizeNodes([{ id: 'X', type: 'ISSUE', points: { number: 3 }, overrun: { number: 2 }, content: { number: 1 } }])
    assert.deepEqual([item?.points, item?.overrun], [3, 2])
  })

  it('null when there is no value', () => {
    const [item] = normalizeNodes([{ id: 'X', type: 'ISSUE', content: { number: 1 } }])
    assert.deepEqual([item?.points, item?.overrun], [null, null])
  })
})

describe('record of Status changes', () => {
  const targets = [
    { repo: 'example-org/app', number: 5 },
    { repo: 'example-org/app-mobile', number: 7 },
  ]

  it('queries the In Progress issues in one call, grouped by repository', () => {
    const query = statusHistoryQuery(targets)
    assert.match(query, /r0: repository\(owner:"example-org", name:"app"\)\{ i5: issue\(number:5\)/)
    assert.match(query, /r1: repository\(owner:"example-org", name:"app-mobile"\)\{ i7: issue\(number:7\)/)
    assert.match(query, /PROJECT_V2_ITEM_STATUS_CHANGED_EVENT/)
  })

  it("queries the repository of an issue whose repository is missing from the config's repos (does not mistake it for the same number in defaultRepo)", () => {
    const query = statusHistoryQuery([{ repo: 'other-owner/tool', number: 2 }, { repo: 'example-org/app', number: 2 }])
    assert.match(query, /r0: repository\(owner:"other-owner", name:"tool"\)\{ i2: issue\(number:2\)/)
    assert.match(query, /r1: repository\(owner:"example-org", name:"app"\)\{ i2: issue\(number:2\)/)
  })

  it("extracts only this board's records, per label", () => {
    const response = {
      data: {
        r0: {
          i5: {
            timelineItems: {
              nodes: [
                { createdAt: '2026-10-29T00:00:00Z', status: 'In Progress', project: { id: 'PVT_test' } },
                { createdAt: '2026-10-29T01:00:00Z', status: 'Backlog', project: { id: 'PVT_other' } },
              ],
            },
          },
        },
      },
    }
    const history = parseStatusHistory(response, [{ repo: 'example-org/app', number: 5 }], config)
    assert.deepEqual(history.get('app#5'), [{ at: '2026-10-29T00:00:00Z', status: 'In Progress' }])
  })

  it('does not include an issue that could not be read (result is null); including it would read as an In Progress period of 0 rather than a missing record', () => {
    const response = { data: { r0: { i5: { timelineItems: { nodes: [{ createdAt: '2026-10-29T00:00:00Z', status: 'In Progress', project: { id: 'PVT_test' } }] } }, i6: null } } }
    const history = parseStatusHistory(response, [{ repo: 'example-org/app', number: 5 }, { repo: 'example-org/app', number: 6 }], config)
    assert.deepEqual([...history.keys()], ['app#5'])
  })

  it('extracts the label of an issue in another repository by its short name, as a number in that repository', () => {
    const response = { data: { r0: { i2: { timelineItems: { nodes: [{ createdAt: '2026-10-29T00:00:00Z', status: 'In Progress', project: { id: 'PVT_test' } }] } } } } }
    const history = parseStatusHistory(response, [{ repo: 'other-owner/tool', number: 2 }], config)
    assert.deepEqual([...history.keys()], ['tool#2'])
  })
})

describe('gh failures in withStatusHistory', () => {
  const doing = (repo: string, number: number) => ({ ...issue(number, { status: 'In Progress' }), repo })
  const withFakeGh = (script: string, run: () => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-fake-gh-'))
    writeFileSync(join(dir, 'gh'), script)
    chmodSync(join(dir, 'gh'), 0o755)
    const saved = process.env.PATH
    process.env.PATH = `${dir}:${saved ?? ''}`
    try {
      run()
    } finally {
      process.env.PATH = saved
    }
  }
  const partial = JSON.stringify({ data: { r0: { i5: { timelineItems: { nodes: [{ createdAt: '2026-10-29T00:00:00Z', status: 'In Progress', project: { id: 'PVT_test' } }] } }, i2: null } }, errors: [{ message: 'Could not resolve to an Issue with the number of 2.' }] })

  it('even if some issues cannot be read (exit code 1), uses the records of the issues that were read and adds nothing for the ones that were not', () => {
    withFakeGh(`#!/bin/sh\ncat <<'EOF'\n${partial}\nEOF\necho 'gh: Could not resolve to an Issue with the number of 2.' >&2\nexit 1\n`, () => {
      const items = withStatusHistory([doing('example-org/app', 5), doing('example-org/app', 2)], config, gh)
      assert.deepEqual(items.map((one) => one.statusEvents?.length ?? null), [1, null])
    })
  })

  it("sends the query to the repository of the item's repo (owner/name); does not remap to the config's defaultRepo", () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'scrum-gh-log-')), 'args.txt')
    const ok = JSON.stringify({ data: { r0: { i2: { timelineItems: { nodes: [] } } }, r1: { i2: { timelineItems: { nodes: [] } } } } })
    withFakeGh(`#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${logFile}'\ncat <<'EOF'\n${ok}\nEOF\n`, () => {
      withStatusHistory([doing('other-owner/tool', 2), doing('example-org/app', 2)], config, gh)
    })
    const query = readFileSync(logFile, 'utf8')
    assert.match(query, /repository\(owner:"other-owner", name:"tool"\)\{ i2: issue\(number:2\)/)
    assert.match(query, /repository\(owner:"example-org", name:"app"\)\{ i2: issue\(number:2\)/)
  })

  it("even with only issues from a repository missing from the config's repos, queries that repository and does not fetch the same number from defaultRepo", () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'scrum-gh-log-')), 'args.txt')
    withFakeGh(`#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${logFile}'\necho '{"data":{"r0":{"i2":{"timelineItems":{"nodes":[]}}}}}'\n`, () => {
      const items = withStatusHistory([doing('other-owner/tool', 2)], config, gh)
      assert.deepEqual(items.map((one) => one.statusEvents), [[]])
    })
    const query = readFileSync(logFile, 'utf8')
    assert.match(query, /owner:"other-owner", name:"tool"/)
    assert.doesNotMatch(query, /name:"app"/)
  })

  it('a failure with no standard output (such as a network failure) returns without adding records', () => {
    withFakeGh('#!/bin/sh\nexit 1\n', () => {
      const items = withStatusHistory([doing('example-org/app', 5)], config, gh)
      assert.deepEqual(items.map((one) => one.statusEvents), [undefined])
    })
  })
})

describe('planMarks', () => {
  const assessed = new Map([
    ['app#1', 2],
    ['app#2', 0],
  ])

  it('rewrites only issues whose overrun count differs from the board; empties it when not exceeded', () => {
    const board = snapshot([
      issue(1, { status: 'In Progress', overrun: null }),
      issue(2, { status: 'In Progress', overrun: 1 }),
      issue(3, { status: 'Backlog', overrun: 3 }),
      issue(4, { status: 'In Progress', overrun: null }),
      pr(5, { overrun: null }),
    ])
    assert.deepEqual(planMarks(board, assessed), [
      { itemId: 'PVTI_1', label: 'app#1', value: 2 },
      { itemId: 'PVTI_2', label: 'app#2', value: null },
      { itemId: 'PVTI_3', label: 'app#3', value: null },
    ])
  })
})

describe('recordDueCheckpoint', () => {
  const doingSince = [{ at: jst('2026-10-29T09:00:00').toISOString(), status: 'In Progress' }]
  const board = snapshot([issue(1, { status: 'In Progress', points: 3, statusEvents: doingSince, overrun: null })])

  it("records a checkpoint not yet recorded and rewrites the board's overrun", () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-cp-')))
    const applied: unknown[] = []
    const record = recordDueCheckpoint(p, config, board, jst('2026-10-30T13:05:00'), (marks) => applied.push(...marks))
    assert.equal(record?.scheduledFor, jst('2026-10-30T13:00:00').toISOString())
    assert.equal(loadRecords(p).length, 1)
    assert.deepEqual(applied, [{ itemId: 'PVTI_1', label: 'app#1', value: 2 }])
  })

  it('does nothing when already recorded', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-cp-')))
    recordDueCheckpoint(p, config, board, jst('2026-10-30T13:05:00'), () => {})
    assert.equal(recordDueCheckpoint(p, config, board, jst('2026-10-30T13:30:00'), () => {}), null)
    assert.equal(loadRecords(p).length, 1)
  })

  it('does not rewrite the board when the config has no overrun field', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-cp-')))
    const { overrunField: _o, ...noField } = sprint
    const applied: unknown[] = []
    recordDueCheckpoint(p, { ...config, sprint: noField }, board, jst('2026-10-30T13:05:00'), (marks) => applied.push(...marks))
    assert.deepEqual(applied, [])
  })
})
