import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseItemPages } from '../src/adapters/github/project-board.ts'
import { parseConfig } from '../src/config.ts'
import { boardToken } from '../src/dispatch/progress.ts'
import { lintDispatch } from '../src/dispatch/rules.ts'
import type { Ack } from '../src/findings/acks.ts'
import type { BoardItem } from '../src/board/types.ts'
import type { DispatchRecord } from '../src/dispatch/types.ts'
import { lintAll } from '../src/findings/lint.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const record = (minutes: number, label = 'app#11'): DispatchRecord => ({ at: minutesAgo(minutes), member: 'SWE1', label, title: 'Next job' })

function pageOf(node: unknown) {
  return [{ data: { node: { items: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } } } }]
}

const baseNode = {
  id: 'PVTI_1',
  type: 'ISSUE',
  status: { name: 'Next' },
  content: { number: 11, title: 'issue 11', state: 'OPEN', author: { login: 'owner' }, repository: { nameWithOwner: 'example-org/app' } },
}

describe('取得結果の、渡す順・ラベル・親の issue', () => {
  it('取っていれば、項目に入れる (親は "<リポジトリ名>#番号")', () => {
    const [item] = parseItemPages(
      JSON.stringify(
        pageOf({
          ...baseNode,
          order: { number: 3 },
          content: { ...baseNode.content, labels: { nodes: [{ name: 'skip-me' }, { name: 'bug' }] }, parent: { number: 100, repository: { nameWithOwner: 'example-org/app' } } },
        }),
      ),
    )
    assert.deepEqual([item?.order, item?.labels, item?.epic], [3, ['skip-me', 'bug'], 'app#100'])
  })

  it('親が無い issue は epic が null、欄が空なら order が null になる', () => {
    const [item] = parseItemPages(JSON.stringify(pageOf({ ...baseNode, order: null, content: { ...baseNode.content, labels: { nodes: [] }, parent: null } })))
    assert.deepEqual([item?.order, item?.labels, item?.epic], [null, [], null])
  })

  it('取っていなければ、キーを足さない (dispatch を使わないボードの控えは今までと同じ)', () => {
    const [item] = parseItemPages(JSON.stringify(pageOf(baseNode)))
    assert.equal('order' in (item ?? {}), false)
    assert.equal('labels' in (item ?? {}), false)
    assert.equal('epic' in (item ?? {}), false)
  })
})

describe('parseConfig の dispatch', () => {
  const { sprint: _s, ...project } = config as typeof config & { sprint?: unknown }

  it('足りない項目は既定で埋める。enabled が無ければ、この機能だけを止める', () => {
    const parsed = parseConfig({ ...project, dispatch: { enabled: true } })
    assert.deepEqual(parsed?.dispatch, { enabled: true, baseBranch: 'main', skipLabels: [], utcOffset: '+09:00', notes: [] })
    assert.equal(parseConfig({ ...project, dispatch: { baseBranch: 'develop' } })?.dispatch, undefined)
    assert.notEqual(parseConfig({ ...project, dispatch: { baseBranch: 'develop' } }), null)
  })

  it('値を読む。形が違えば、この機能だけを止める', () => {
    const full = { enabled: true, baseBranch: 'develop', skipLabels: ['a'], orderField: 'Order', utcOffset: '+09:00', notes: ['n'], members: ['SWE1'], scriptDir: '~/tools' }
    assert.deepEqual(parseConfig({ ...project, dispatch: full })?.dispatch, full)
    for (const bad of [{ ...full, enabled: 'yes' }, { ...full, skipLabels: [1] }, { ...full, utcOffset: '9' }, { ...full, baseBranch: '' }, { ...full, members: 'SWE1' }, { ...full, scriptDir: '' }]) {
      assert.equal(parseConfig({ ...project, dispatch: bad })?.dispatch, undefined)
    }
  })
})

describe('lintDispatch (A-DISPATCHED)', () => {
  it('渡したことを、誰に何を渡したかつきの中の指摘にする。指紋は記録ごとに変わる', () => {
    const [first, second] = lintDispatch([record(10), record(20, 'app#12')], config, NOW)
    assert.deepEqual([first?.rule, first?.severity, first?.subject], ['A-DISPATCHED', 'medium', 'app#11'])
    assert.match(first?.message ?? '', /SWE1 was idle, so app#11 Next job was handed over automatically/)
    assert.notEqual(first?.key, second?.key)
  })

  it('2 時間より前の記録は出さない', () => {
    assert.deepEqual(lintDispatch([record(121)], config, NOW), [])
    assert.equal(lintDispatch([record(120)], config, NOW).length, 1)
  })

  it('lintAll に載り、TechLead への通知の対象 (中以上) になる', () => {
    const ctx = { snapshot: snapshot([issue(11, { status: 'In Progress', assignee: 'SWE1' })]), members: [], acks: [], config, now: NOW, dispatches: [record(5)] }
    assert.deepEqual(lintAll(ctx).active.filter((finding) => finding.rule === 'A-DISPATCHED').map((finding) => finding.severity), ['medium'])
  })
})

describe('A-NUDGE-IGNORED', () => {
  const idle = (minutes: number) => [{ name: 'SWE1', state: 'idle' as const, since: minutesAgo(minutes) }]
  const nudge = (minutes: number, progress?: DispatchRecord['progress']): DispatchRecord => ({
    kind: 'nudge',
    at: minutesAgo(minutes),
    member: 'SWE1',
    label: 'app#240',
    title: 'Ongoing job',
    ...(progress === undefined ? {} : { progress }),
  })

  it('作業が進まないまま促しを 2 回送って、いまも空きの部下を、中の指摘にする', () => {
    const [finding] = lintDispatch([nudge(40), nudge(20)], config, NOW, idle(50))
    assert.deepEqual([finding?.rule, finding?.severity, finding?.subject], ['A-NUDGE-IGNORED', 'medium', 'SWE1'])
    assert.match(finding?.message ?? '', /SWE1 was nudged 2 times to continue app#240, which is In Progress, but went back to idle with no work in between \(board change, PR or linked-branch activity\)\. Idle now for 50 minutes/)
  })

  it('空きの区間が変わっても (促しの後、短い 1 ターンで空きに戻った) 続けて数え、1 回だけ出る', () => {
    const records = [nudge(100), nudge(80), nudge(40)]
    const findings = lintDispatch(records, config, NOW, idle(30))
    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.key, lintDispatch([nudge(100), nudge(80)], config, NOW, idle(60))[0]?.key)
  })

  it('促しが 1 回だけ、動いている、3 時間より前の促しだけ、のときは出さない', () => {
    assert.deepEqual(lintDispatch([nudge(20)], config, NOW, idle(50)), [])
    assert.deepEqual(lintDispatch([nudge(40), nudge(20)], config, NOW, [{ name: 'SWE1', state: 'busy', since: minutesAgo(5) }]), [])
    assert.deepEqual(lintDispatch([nudge(300), nudge(250)], config, NOW, idle(50)), [])
  })

  it('促しの後に作業が進んだ (ボードの印が変わった) なら、出さない。進んだ後の促しから数え直す', () => {
    const board = snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })])
    const now = boardToken(board.items[0] as BoardItem)
    assert.deepEqual(lintDispatch([nudge(100, { board: 'before', github: null }), nudge(80, { board: 'before', github: null })], config, NOW, idle(50), board), [])
    assert.equal(lintDispatch([nudge(100, { board: 'before', github: null }), nudge(80, { board: now, github: null }), nudge(60, { board: now, github: null })], config, NOW, idle(50), board).length, 1)
  })

  it('作業中の issue ごとに数える。ほかの issue への促しは混ぜない', () => {
    const other = (minutes: number): DispatchRecord => ({ ...nudge(minutes), label: 'app#999' })
    assert.deepEqual(lintDispatch([nudge(40), other(30)], config, NOW, idle(50)), [])
    assert.deepEqual(lintDispatch([nudge(40), other(30), nudge(20)], config, NOW, idle(50)).map((finding) => finding.rule), ['A-NUDGE-IGNORED'])
  })

  it('促しは A-DISPATCHED に数えない (渡した記録だけ)', () => {
    assert.deepEqual(lintDispatch([nudge(5)], config, NOW).map((finding) => finding.rule), [])
  })

  it('lintAll に載る (部下の稼働を渡す)', () => {
    const ctx = {
      snapshot: snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })]),
      members: idle(50),
      acks: [],
      config,
      now: NOW,
      dispatches: [nudge(40), nudge(20)],
    }
    assert.deepEqual(lintAll(ctx).active.filter((finding) => finding.rule === 'A-NUDGE-IGNORED').map((finding) => finding.subject), ['SWE1'])
  })

  it('指紋は、続いた促しの最初の時刻ごとに変わる (作業が進んだ後の、新しい続きは、また出る)', () => {
    const first = lintDispatch([nudge(60), nudge(20)], config, NOW, idle(50))[0]
    const board = snapshot([issue(240, { status: 'In Progress', assignee: 'SWE1' })])
    const progressed = lintDispatch([nudge(200, { board: 'before', github: null }), nudge(40, { board: boardToken(board.items[0] as BoardItem), github: null }), nudge(20, { board: boardToken(board.items[0] as BoardItem), github: null })], config, NOW, idle(50), board)[0]
    assert.notEqual(first?.key, progressed?.key)
  })
})

describe('保存された T-IDLE の受け入れと、T-IDLE の指摘', () => {
  const idleMember = [{ name: 'SWE1', state: 'idle' as const, since: minutesAgo(30) }]
  const base = { snapshot: snapshot([]), members: idleMember, config, now: NOW }
  const tIdle = (acks: Ack[]) => lintAll({ ...base, acks }).active.filter((finding) => finding.rule === 'T-IDLE').map((finding) => finding.subject)
  const ack = (overrides: Partial<Ack>): Ack => ({ rule: 'T-IDLE', subject: 'SWE1', at: minutesAgo(5), until: new Date(NOW.getTime() + 55 * 60_000).toISOString(), reason: "Waiting for the owner's answer", ...overrides })

  it('検査を通る受け入れ (最長 1 時間、決まった理由) は、T-IDLE の指摘を黙らせる', () => {
    assert.deepEqual(tIdle([ack({})]), [])
  })

  it('検査を入れる前に作られた受け入れ (長い期限、余力の理由、理由の後ろの文字) は、T-IDLE の指摘を黙らせない', () => {
    assert.deepEqual(tIdle([ack({ reason: 'Because of spare context capacity', until: new Date(NOW.getTime() + 4 * 60 * 60_000).toISOString() })]), ['SWE1'])
    assert.deepEqual(tIdle([ack({ until: new Date(NOW.getTime() + 4 * 60 * 60_000).toISOString() })]), ['SWE1'])
    assert.deepEqual(tIdle([ack({ reason: "Waiting for the owner's answer, low capacity" })]), ['SWE1'])
  })

  it('T-IDLE 以外の規則の受け入れは、検査しない', () => {
    const wip = { ...ack({}), rule: 'B-WIP-OVER', reason: 'anything', until: new Date(NOW.getTime() + 40 * 60 * 60_000).toISOString() }
    assert.deepEqual(tIdle([wip, ack({ reason: 'capacity', until: NOW.toISOString() })]), ['SWE1'])
  })
})

