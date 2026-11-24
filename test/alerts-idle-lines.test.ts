import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { idleLines } from '../src/alerts/idle-lines.ts'
import type { AlertInput } from '../src/alerts/rules.ts'
import type { DispatchRecord } from '../src/dispatch/types.ts'
import type { Ack } from '../src/findings/acks.ts'
import type { MemberState } from '../src/team/types.ts'
import { NOW, snapshot } from './helpers.ts'
import { busy, enabled, idle, minutesAgo, minutesLater, stateWith } from './alerts-fixtures.ts'

const input = (members: readonly MemberState[], overrides: Partial<AlertInput> = {}): AlertInput => ({
  snapshot: snapshot([]),
  members,
  acks: [],
  dispatches: [],
  alerts: stateWith({}),
  config: enabled,
  now: NOW,
  ...overrides,
})

describe('idleLines', () => {
  it('部下が idleMinutes 空いたら、窓口への 1 行を作る。macOS の通知は付けない', () => {
    const [line, ...rest] = idleLines(input([idle('SWE1', 10)]))
    assert.equal(rest.length, 0)
    assert.equal(line?.kind, 'idle-line')
    assert.equal(line?.desktop, undefined)
    assert.equal(line?.text, '- SWE1 が 10 分空いた。受け入れ: なし。ハーネスの動き: まだ送っていない')
    assert.equal(line?.key, `idle-line:SWE1:${minutesAgo(10)}`)
  })

  it('idleMinutes に満たない空き、動いている人、部下でない人 (TechLead) は出さない', () => {
    assert.deepEqual(idleLines(input([idle('SWE1', 9), busy('SWE2'), idle('TechLead', 30)])), [])
  })

  it('受け入れがあっても出し、受け入れの理由と終わりの時刻 (JST) を書く', () => {
    const ack: Ack = { rule: 'T-IDLE', subject: 'SWE1', until: minutesLater(30).toISOString(), reason: 'オーナーの答え待ち', at: minutesAgo(5) }
    const [line] = idleLines(input([idle('SWE1', 15)], { acks: [ack] }))
    assert.match(line?.text ?? '', /受け入れ: オーナーの答え待ち \(15:30 まで\)/)
  })

  it('期限が切れた受け入れと、他の人の受け入れは、受け入れなしと書く', () => {
    const old: Ack = { rule: 'T-IDLE', subject: 'SWE1', until: minutesAgo(1), reason: 'オーナーの答え待ち', at: minutesAgo(50) }
    const other: Ack = { ...old, subject: 'SWE2', until: minutesLater(30).toISOString() }
    assert.match(idleLines(input([idle('SWE1', 15)], { acks: [old, other] }))[0]?.text ?? '', /受け入れ: なし/)
  })

  it('空きの間に渡した issue と促しは、最後のものを時刻つきで書く。空きの前のものは書かない', () => {
    const before: DispatchRecord = { at: minutesAgo(30), member: 'SWE1', label: 'app#5', title: 'x' }
    const given: DispatchRecord = { at: minutesAgo(8), member: 'SWE1', label: 'app#11', title: 'y' }
    const nudge: DispatchRecord = { kind: 'nudge', at: minutesAgo(2), member: 'SWE1', label: 'app#12', title: 'z' }
    const members = [idle('SWE1', 15)]
    assert.match(idleLines(input(members, { dispatches: [before] }))[0]?.text ?? '', /まだ送っていない/)
    assert.match(idleLines(input(members, { dispatches: [before, given] }))[0]?.text ?? '', /渡した app#11 \(14:52\)/)
    assert.match(idleLines(input(members, { dispatches: [before, given, nudge] }))[0]?.text ?? '', /促した app#12 \(14:58\)/)
  })

  it('渡せる issue が無いと検知した部下は、そう書く', () => {
    const line = idleLines(input([idle('SWE1', 15)], { alerts: stateWith({ empty: { 'SWE1:no-candidate': minutesAgo(5) } }) }))[0]
    assert.match(line?.text ?? '', /ハーネスの動き: 渡せる issue が無い$/)
  })

  it('空きの区間が変われば、指紋も変わる (空き直した人にまた出す)', () => {
    assert.notEqual(idleLines(input([idle('SWE1', 15)]))[0]?.key, idleLines(input([idle('SWE1', 12)]))[0]?.key)
  })
})
