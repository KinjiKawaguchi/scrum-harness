import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { advanceEpics, epicViews } from '../src/alerts/epic.ts'
import { evaluateEpicStalls } from '../src/alerts/epic-findings.ts'
import type { MemberState } from '../src/team/types.ts'
import { config, NOW, snapshot } from './helpers.ts'
import { busy, child, enabled, epic, idle, minutesAgo } from './alerts-fixtures.ts'

const doing = (number: number, tanto: string | null, reason = 'なし') => child(number, { status: '作業中', tanto, reason })

describe('epicViews', () => {
  it('作業中の子を持つ人が動いていれば、その人が動いている人になる', () => {
    const views = epicViews(snapshot([epic(), doing(101, 'SWE1'), child(102, { status: '次にやる' })]), [busy('SWE1'), idle('SWE2')], enabled)
    assert.deepEqual(views.map((view) => [view.epic, view.movers, view.openChildren.length]), [['app#100', ['SWE1'], 2]])
  })

  it('許可待ち (waiting) の人は、動いている人に数えない。作業中 (busy) の人だけが数える', () => {
    const items = [epic(), doing(101, 'SWE1')]
    const waiting: MemberState = { name: 'SWE1', state: 'waiting', since: minutesAgo(5) }
    assert.deepEqual(epicViews(snapshot(items), [waiting], enabled).map((view) => view.movers), [[]])
    assert.deepEqual(epicViews(snapshot(items), [busy('SWE1')], enabled).map((view) => view.movers), [['SWE1']])
  })

  it('作業中の子の担当が空いている (動いていない) か、担当が無ければ、動いている人はいない', () => {
    const members = [idle('SWE1'), busy('SWE2')]
    assert.deepEqual(epicViews(snapshot([epic(), doing(101, 'SWE1')]), members, enabled).map((view) => view.movers), [[]])
    assert.deepEqual(epicViews(snapshot([epic(), doing(101, null)]), members, enabled).map((view) => view.movers), [[]])
  })

  it('動いている人が別の Epic の作業中の子を持っていても、この Epic を動かしている人には数えない', () => {
    const other = child(201, { epic: 'app#200', status: '作業中', tanto: 'SWE2' })
    const views = epicViews(snapshot([epic(), child(101, { status: '次にやる' }), other]), [busy('SWE2')], enabled)
    assert.deepEqual(views.map((view) => [view.epic, view.movers]), [['app#100', []], ['app#200', ['SWE2']]])
  })

  it('子がすべてバックログの Epic も、動く人が要る Epic に入れる (動いている人は 0)', () => {
    const views = epicViews(snapshot([epic(), child(101, { status: 'バックログ' }), child(102, { status: 'バックログ' })]), [busy('SWE1')], enabled)
    assert.deepEqual(views.map((view) => [view.epic, view.movers, view.openChildren.length]), [['app#100', [], 2]])
  })

  it('子がリリース待ちか完了だけ (作業は済んでいる) の Epic は入れない。バックログの子が 1 つでもあれば入れる', () => {
    const done = [epic(), child(101, { status: 'リリース待ち' }), child(102, { status: '完了' })]
    assert.deepEqual(epicViews(snapshot(done), [], enabled), [])
    assert.equal(epicViews(snapshot([...done, child(103, { status: 'バックログ' })]), [], enabled).length, 1)
  })

  it('積んである印のラベル (alerts.parkedLabels) が Epic 自身に付いていれば、入れない', () => {
    const items = [child(101, { status: 'バックログ' })]
    assert.deepEqual(epicViews(snapshot([epic({ labels: ['epic:parked'] }), ...items]), [], enabled), [])
    assert.equal(epicViews(snapshot([epic({ labels: ['bug'] }), ...items]), [], enabled).length, 1)
    const custom = { ...enabled, alerts: { ...enabled.alerts!, parkedLabels: ['積んである'] } }
    assert.deepEqual(epicViews(snapshot([epic({ labels: ['積んである'] }), ...items]), [], custom), [])
    assert.equal(epicViews(snapshot([epic({ labels: ['epic:parked'] }), ...items]), [], custom).length, 1)
  })

  it('子のラベルは見ない (積んである印は Epic 自身のラベルだけ)。Epic がボードに無ければ、印は読めないので入れる', () => {
    assert.equal(epicViews(snapshot([epic(), child(101, { status: 'バックログ', labels: ['epic:parked'] })]), [], enabled).length, 1)
    assert.equal(epicViews(snapshot([child(101, { status: 'バックログ' })]), [], enabled).length, 1)
  })

  it('次にやるの子だけの Epic は、動くはずで、動いている人はいない', () => {
    const views = epicViews(snapshot([epic(), child(101, { status: '次にやる' })]), [idle('SWE1')], enabled)
    assert.deepEqual(views.map((view) => [view.epic, view.movers, view.doing.length]), [['app#100', [], 0]])
  })

  it('Epic 自身がボードで閉じていれば入れない。ボードに無ければ入れる (題は無い)', () => {
    const open = [child(101, { status: '次にやる' })]
    assert.deepEqual(epicViews(snapshot([epic({ state: 'CLOSED' }), ...open]), [], enabled), [])
    assert.deepEqual(epicViews(snapshot(open), [], enabled).map((view) => [view.epic, view.title]), [['app#100', null]])
  })

  it('Epic 自身の作者が excludeAuthors (別の開発主体) なら、子の作者に関係なく入れない', () => {
    const items = [epic({ author: 'external-dev' }), child(101, { status: 'バックログ' })]
    assert.deepEqual(epicViews(snapshot(items), [], enabled), [])
    assert.equal(epicViews(snapshot([epic({ author: 'owner' }), child(101, { status: 'バックログ' })]), [], enabled).length, 1)
  })

  it('閉じた子、PR、除く作者の issue は、子として数えない', () => {
    const items = [
      epic(),
      child(101, { status: '次にやる', state: 'CLOSED' }),
      child(102, { status: '次にやる', kind: 'pr' }),
      child(103, { status: '次にやる', author: 'external-dev' }),
    ]
    assert.deepEqual(epicViews(snapshot(items), [], enabled), [])
  })

  it('親を取っていない (epic の欄が無い) issue しか無ければ、Epic は無い', () => {
    assert.deepEqual(epicViews(snapshot([epic({ status: '作業中', tanto: 'SWE1' })]), [busy('SWE1')], enabled), [])
  })
})

describe('advanceEpics', () => {
  const stalled = epicViews(snapshot([epic(), child(101, { status: '次にやる' })]), [idle('SWE1')], enabled)
  const moving = epicViews(snapshot([epic(), doing(101, 'SWE1')]), [busy('SWE1')], enabled)

  it('初めて見た動いている人のいない Epic は、いまの時刻を最初に見た時刻にする', () => {
    assert.deepEqual(advanceEpics({}, stalled, NOW), { 'app#100': NOW.toISOString() })
  })

  it('続けて見たときは、前の時刻を引き継ぐ', () => {
    const first = minutesAgo(45)
    assert.deepEqual(advanceEpics({ 'app#100': first }, stalled, NOW), { 'app#100': first })
  })

  it('動き出した Epic は消え、また止まれば、新しい時刻から数え直す', () => {
    const first = minutesAgo(45)
    assert.deepEqual(advanceEpics({ 'app#100': first }, moving, NOW), {})
    assert.deepEqual(advanceEpics({}, stalled, NOW), { 'app#100': NOW.toISOString() })
  })
})

describe('evaluateEpicStalls', () => {
  const views = (items = [epic(), child(101, { status: '次にやる' })]) => epicViews(snapshot(items), [idle('SWE1')], enabled)

  it('60 分に 1 分足りなければ出さず、60 分で E-STALL (重さ高) を出す', () => {
    assert.deepEqual(evaluateEpicStalls(views(), { 'app#100': minutesAgo(59) }, enabled, NOW).findings, [])
    const stalled = evaluateEpicStalls(views(), { 'app#100': minutesAgo(60) }, enabled, NOW)
    const [finding, ...rest] = stalled.findings
    assert.doesNotMatch(stalled.owner[0]?.text ?? '', /問い/)
    assert.equal(rest.length, 0)
    assert.deepEqual([finding?.rule, finding?.severity, finding?.subject, finding?.minutes], ['E-STALL', 'high', 'app#100', 60])
    assert.match(finding?.message ?? '', /^Epic app#100「Epic 100」を動かしている人がいない状態が 60 分続いている \(開いた子 1 件。作業中の子なし\)$/)
    assert.equal(finding?.key, `E-STALL:app#100:${minutesAgo(60)}`)
  })

  it('最初に見た時刻がまだ無い Epic は出さない', () => {
    assert.deepEqual(evaluateEpicStalls(views(), {}, enabled, NOW), { findings: [], owner: [] })
  })

  it('分の上限は設定の epicStallMinutes に従う', () => {
    const short = { ...enabled, alerts: { ...enabled.alerts!, epicStallMinutes: 20 } }
    assert.equal(evaluateEpicStalls(views(), { 'app#100': minutesAgo(20) }, short, NOW).findings.length, 1)
  })

  it('作業中の子が、すべてオーナーの判断待ちなら、待っている子を通知に載せ、問いを添えさせる', () => {
    const waiting = views([epic(), doing(101, 'SWE1', '判断待ち'), doing(102, 'SWE1', '判断待ち')])
    const result = evaluateEpicStalls(waiting, { 'app#100': minutesAgo(61) }, enabled, NOW)
    const notice = result.owner[0]
    assert.match(notice?.text ?? '', /待っているのは app#101、app#102 です/)
    assert.match(notice?.text ?? '', /待っている問いの文を 1 行添える \(対象: app#101、app#102\)/)
    assert.match(notice?.desktop?.body ?? '', /待っているのは app#101、app#102 です/)
    assert.match(result.findings[0]?.fix ?? '', /オーナーの答え待ちだけで止まっている/)
    assert.match(result.findings[0]?.message ?? '', /作業中の子: app#101 担当 SWE1 理由 判断待ち、app#102 担当 SWE1 理由 判断待ち/)
  })

  it('作業中の子に判断待ち以外が 1 つでもあれば、問いは添えさせない', () => {
    const mixed = views([epic(), doing(101, 'SWE1', '判断待ち'), doing(102, 'SWE1', 'なし')])
    const result = evaluateEpicStalls(mixed, { 'app#100': minutesAgo(61) }, enabled, NOW)
    assert.doesNotMatch(result.owner[0]?.text ?? '', /問い/)
    assert.doesNotMatch(result.owner[0]?.desktop?.body ?? '', /待っているのは/)
    assert.match(result.findings[0]?.fix ?? '', /担当を動かす/)
  })

  it('通知の key は指摘の key と同じで、macOS の通知を持つ。題は 40 字で切る', () => {
    const long = views([epic({ title: 'あ'.repeat(50) }), child(101, { status: '次にやる' })])
    const result = evaluateEpicStalls(long, { 'app#100': minutesAgo(61) }, enabled, NOW)
    assert.equal(result.owner[0]?.key, result.findings[0]?.key)
    assert.equal(result.owner[0]?.kind, 'owner')
    assert.match(result.owner[0]?.desktop?.body ?? '', new RegExp(`「${'あ'.repeat(40)}…」`))
  })

  it('Epic がボードに無く題が分からなければ、題を付けずに出す', () => {
    const noTitle = views([child(101, { status: '次にやる' })])
    const finding = evaluateEpicStalls(noTitle, { 'app#100': minutesAgo(60) }, enabled, NOW).findings[0]
    assert.match(finding?.message ?? '', /^Epic app#100 を動かしている人がいない/)
  })

  it('alerts の設定が無い config でも、上限は既定の 60 分', () => {
    const plain = { ...config, alerts: undefined }
    assert.equal(evaluateEpicStalls(views(), { 'app#100': minutesAgo(60) }, plain, NOW).findings.length, 1)
    assert.equal(evaluateEpicStalls(views(), { 'app#100': minutesAgo(59) }, plain, NOW).findings.length, 0)
  })
})

describe('まとめた通知の 1 行 (止まっている理由)', () => {
  const lineOf = (items: Parameters<typeof snapshot>[0]) =>
    evaluateEpicStalls(epicViews(snapshot(items), [idle('SWE1')], enabled), { 'app#100': minutesAgo(61) }, enabled, NOW).owner[0]?.owner?.line

  it('作業中の子が無いときは、次にやると バックログの子の数を書く', () => {
    assert.equal(lineOf([epic(), child(101, { status: '次にやる' }), child(102, { status: 'バックログ' }), child(103, { status: 'バックログ' })]), 'app#100「Epic 100」を動かす人がいない 61 分 (作業中の子なし (次にやる 1 件、バックログ 2 件))')
  })

  it('作業中の子があるときは、その数と、止まっている理由 (重ねずに) を書く', () => {
    assert.equal(lineOf([epic(), doing(101, null, '外部待ち'), doing(102, null, '外部待ち'), doing(103, null, 'なし')]), 'app#100「Epic 100」を動かす人がいない 61 分 (作業中の子 3 件が、外部待ち、なし で止まっている)')
  })

  it('作業中の子がすべて判断待ちなら、オーナーの答え待ちと、その子の番号を書く', () => {
    assert.equal(lineOf([epic(), doing(101, 'SWE1', '判断待ち'), doing(102, 'SWE1', '判断待ち')]), 'app#100「Epic 100」を動かす人がいない 61 分 (オーナーの答え待ち (app#101、app#102))')
  })
})
