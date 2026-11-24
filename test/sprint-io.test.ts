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
  pointsField: 'ストーリーポイント',
  overrunField: '超過',
  pointBudgets: { '1': 1, '2': 1, '3': 2, '5': 3, '8': 5 },
}
const config: Config = { ...base, sprint }
const jst = (text: string) => new Date(`${text}+09:00`)

describe('parseConfig の sprint', () => {
  it('そろっていれば使う', () => {
    assert.deepEqual(parseConfig({ ...base, sprint })?.sprint, sprint)
  })

  it('欠けているか形が違えば、sprint だけを外し、ほかは使う', () => {
    const broken = parseConfig({ ...base, sprint: { ...sprint, utcOffset: 'JST' } })
    assert.equal(broken?.sprint, undefined)
    assert.equal(broken?.techlead, 'TechLead')
    assert.equal(parseConfig({ ...base, sprint: { ...sprint, checkpoints: ['8時'] } })?.sprint, undefined)
  })
})

describe('ポイントと超過の欄の取り出し', () => {
  it('Number の欄の値を読む', () => {
    const [item] = normalizeNodes([{ id: 'X', type: 'ISSUE', points: { number: 3 }, overrun: { number: 2 }, content: { number: 1 } }])
    assert.deepEqual([item?.points, item?.overrun], [3, 2])
  })

  it('値が無ければ null', () => {
    const [item] = normalizeNodes([{ id: 'X', type: 'ISSUE', content: { number: 1 } }])
    assert.deepEqual([item?.points, item?.overrun], [null, null])
  })
})

describe('Status の変化の記録', () => {
  const targets = [
    { repo: 'example-org/app', number: 5 },
    { repo: 'example-org/app-mobile', number: 7 },
  ]

  it('作業中の issue をリポジトリごとにまとめて1回で問い合わせる', () => {
    const query = statusHistoryQuery(targets)
    assert.match(query, /r0: repository\(owner:"example-org", name:"app"\)\{ i5: issue\(number:5\)/)
    assert.match(query, /r1: repository\(owner:"example-org", name:"app-mobile"\)\{ i7: issue\(number:7\)/)
    assert.match(query, /PROJECT_V2_ITEM_STATUS_CHANGED_EVENT/)
  })

  it('設定の repos に無いリポジトリの issue は、そのリポジトリに問い合わせる (defaultRepo の同じ番号と取り違えない)', () => {
    const query = statusHistoryQuery([{ repo: 'other-owner/tool', number: 2 }, { repo: 'example-org/app', number: 2 }])
    assert.match(query, /r0: repository\(owner:"other-owner", name:"tool"\)\{ i2: issue\(number:2\)/)
    assert.match(query, /r1: repository\(owner:"example-org", name:"app"\)\{ i2: issue\(number:2\)/)
  })

  it('このボードの記録だけを、ラベルごとに取り出す', () => {
    const response = {
      data: {
        r0: {
          i5: {
            timelineItems: {
              nodes: [
                { createdAt: '2026-10-29T00:00:00Z', status: '作業中', project: { id: 'PVT_test' } },
                { createdAt: '2026-10-29T01:00:00Z', status: 'バックログ', project: { id: 'PVT_other' } },
              ],
            },
          },
        },
      },
    }
    const history = parseStatusHistory(response, [{ repo: 'example-org/app', number: 5 }], config)
    assert.deepEqual(history.get('app#5'), [{ at: '2026-10-29T00:00:00Z', status: '作業中' }])
  })

  it('読めなかった issue (結果が null) は入れない。入れると、記録が無いのでなく、作業中の期間が 0 と読まれる', () => {
    const response = { data: { r0: { i5: { timelineItems: { nodes: [{ createdAt: '2026-10-29T00:00:00Z', status: '作業中', project: { id: 'PVT_test' } }] } }, i6: null } } }
    const history = parseStatusHistory(response, [{ repo: 'example-org/app', number: 5 }, { repo: 'example-org/app', number: 6 }], config)
    assert.deepEqual([...history.keys()], ['app#5'])
  })

  it('別のリポジトリの issue のラベルは、短い名前で、そのリポジトリの番号として取り出す', () => {
    const response = { data: { r0: { i2: { timelineItems: { nodes: [{ createdAt: '2026-10-29T00:00:00Z', status: '作業中', project: { id: 'PVT_test' } }] } } } } }
    const history = parseStatusHistory(response, [{ repo: 'other-owner/tool', number: 2 }], config)
    assert.deepEqual([...history.keys()], ['tool#2'])
  })
})

describe('withStatusHistory の gh の失敗', () => {
  const doing = (repo: string, number: number) => ({ ...issue(number, { status: '作業中' }), repo })
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
  const partial = JSON.stringify({ data: { r0: { i5: { timelineItems: { nodes: [{ createdAt: '2026-10-29T00:00:00Z', status: '作業中', project: { id: 'PVT_test' } }] } }, i2: null } }, errors: [{ message: 'Could not resolve to an Issue with the number of 2.' }] })

  it('一部の issue が読めなくても (終了コード 1)、読めた issue の記録は使い、読めなかった issue には足さない', () => {
    withFakeGh(`#!/bin/sh\ncat <<'EOF'\n${partial}\nEOF\necho 'gh: Could not resolve to an Issue with the number of 2.' >&2\nexit 1\n`, () => {
      const items = withStatusHistory([doing('example-org/app', 5), doing('example-org/app', 2)], config, gh)
      assert.deepEqual(items.map((one) => one.statusEvents?.length ?? null), [1, null])
    })
  })

  it('問い合わせは、項目の repo (owner/name) のリポジトリへ出す。設定の defaultRepo に引き直さない', () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'scrum-gh-log-')), 'args.txt')
    const ok = JSON.stringify({ data: { r0: { i2: { timelineItems: { nodes: [] } } }, r1: { i2: { timelineItems: { nodes: [] } } } } })
    withFakeGh(`#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${logFile}'\ncat <<'EOF'\n${ok}\nEOF\n`, () => {
      withStatusHistory([doing('other-owner/tool', 2), doing('example-org/app', 2)], config, gh)
    })
    const query = readFileSync(logFile, 'utf8')
    assert.match(query, /repository\(owner:"other-owner", name:"tool"\)\{ i2: issue\(number:2\)/)
    assert.match(query, /repository\(owner:"example-org", name:"app"\)\{ i2: issue\(number:2\)/)
  })

  it('設定の repos に無いリポジトリの issue だけでも、そのリポジトリに問い合わせ、defaultRepo の同じ番号を引かない', () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'scrum-gh-log-')), 'args.txt')
    withFakeGh(`#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${logFile}'\necho '{"data":{"r0":{"i2":{"timelineItems":{"nodes":[]}}}}}'\n`, () => {
      const items = withStatusHistory([doing('other-owner/tool', 2)], config, gh)
      assert.deepEqual(items.map((one) => one.statusEvents), [[]])
    })
    const query = readFileSync(logFile, 'utf8')
    assert.match(query, /owner:"other-owner", name:"tool"/)
    assert.doesNotMatch(query, /name:"app"/)
  })

  it('標準出力に何も無い失敗 (通信の失敗など) は、記録を足さずに返す', () => {
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

  it('超えた数がボードと違う issue だけ書き換える。超えていなければ空にする', () => {
    const board = snapshot([
      issue(1, { status: '作業中', overrun: null }),
      issue(2, { status: '作業中', overrun: 1 }),
      issue(3, { status: 'バックログ', overrun: 3 }),
      issue(4, { status: '作業中', overrun: null }),
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
  const doingSince = [{ at: jst('2026-10-29T09:00:00').toISOString(), status: '作業中' }]
  const board = snapshot([issue(1, { status: '作業中', points: 3, statusEvents: doingSince, overrun: null })])

  it('まだ記録していない節目を記録し、ボードの超過を書き換える', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-cp-')))
    const applied: unknown[] = []
    const record = recordDueCheckpoint(p, config, board, jst('2026-10-30T13:05:00'), (marks) => applied.push(...marks))
    assert.equal(record?.scheduledFor, jst('2026-10-30T13:00:00').toISOString())
    assert.equal(loadRecords(p).length, 1)
    assert.deepEqual(applied, [{ itemId: 'PVTI_1', label: 'app#1', value: 2 }])
  })

  it('記録済みなら何もしない', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-cp-')))
    recordDueCheckpoint(p, config, board, jst('2026-10-30T13:05:00'), () => {})
    assert.equal(recordDueCheckpoint(p, config, board, jst('2026-10-30T13:30:00'), () => {}), null)
    assert.equal(loadRecords(p).length, 1)
  })

  it('超過の欄が設定に無ければ、ボードは書き換えない', () => {
    const p = paths(mkdtempSync(join(tmpdir(), 'scrum-cp-')))
    const { overrunField: _o, ...noField } = sprint
    const applied: unknown[] = []
    recordDueCheckpoint(p, { ...config, sprint: noField }, board, jst('2026-10-30T13:05:00'), (marks) => applied.push(...marks))
    assert.deepEqual(applied, [])
  })
})
