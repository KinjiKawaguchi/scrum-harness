import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeOwner } from '../src/alerts/merge.ts'
import type { Notice } from '../src/alerts/types.ts'
import { enabled } from './alerts-fixtures.ts'

const notice = (key: string, line: string, waiting: readonly string[] = []): Notice => ({
  key,
  kind: 'owner',
  text: `- ${key}`,
  desktop: { title: 't', body: key },
  owner: { line, waiting },
})

describe('mergeOwner', () => {
  it('通知が無ければ null、1 件ならそのまま返す', () => {
    assert.equal(mergeOwner([], enabled), null)
    const one = notice('A', 'a の行')
    assert.equal(mergeOwner([one], enabled), one)
  })

  it('2 件以上は、1 通にまとめ、1 件ごとに 1 行を並べ、まとめた分の指紋をすべて持つ', () => {
    const merged = mergeOwner([notice('B', 'b の行'), notice('A', 'a の行')], enabled)
    assert.equal(merged?.kind, 'owner')
    assert.deepEqual(merged?.members, ['B', 'A'])
    assert.equal(merged?.key, 'batch:A+B')
    assert.equal(merged?.desktop?.body, '止まりが 2 件あります。\n・b の行\n・a の行')
    assert.equal(
      merged?.text,
      ['- 止まり 2 件: オーナーに PushNotification を 1 通送る (音は鳴らさない。本文は変えない)', '  止まりが 2 件あります。', '  ・b の行', '  ・a の行'].join('\n'),
    )
  })

  it('問いを添える対象は、まとめた全部の分を、1 行で伝える', () => {
    const merged = mergeOwner([notice('A', 'a', ['app#1']), notice('B', 'b'), notice('C', 'c', ['app#2', 'app#3'])], enabled)
    assert.match(merged?.text ?? '', /\n  オーナーの答え待ちの分は、待っている問いの文を 1 行添える \(対象: app#1、app#2、app#3\)$/)
    assert.doesNotMatch(mergeOwner([notice('A', 'a'), notice('B', 'b')], enabled)?.text ?? '', /問い/)
  })

  it('まとめた通知をさらにまとめても、元の指紋を持ち続ける', () => {
    const first = mergeOwner([notice('A', 'a'), notice('B', 'b')], enabled)
    const second = mergeOwner([first as Notice, notice('C', 'c')], enabled)
    assert.deepEqual(second?.members, ['A', 'B', 'C'])
  })

  it('指紋は、並び順によらない', () => {
    assert.equal(mergeOwner([notice('A', 'a'), notice('B', 'b')], enabled)?.key, mergeOwner([notice('B', 'b'), notice('A', 'a')], enabled)?.key)
  })
})
