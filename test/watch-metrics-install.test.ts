import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LintContext } from '../src/findings/lint.ts'
import { MARKER, withHooks, withoutHooks } from '../src/install.ts'
import { formatReport, transitions, type MetricsEvent } from '../src/metrics/events.ts'
import { decideWake, hasPending } from '../src/watch.ts'
import type { MemberState } from '../src/team/types.ts'
import { makeFinding } from '../src/findings/types.ts'
import { config, issue, NOW, snapshot } from './helpers.ts'

function ctx(techleadState: MemberState['state']): LintContext {
  return {
    snapshot: snapshot([issue(1, { status: '作業中' }), issue(2, { reason: null })]),
    members: [{ name: 'TechLead', state: techleadState, since: NOW.toISOString() }],
    acks: [],
    config,
    now: NOW,
  }
}

describe('decideWake', () => {
  it('TechLead が空いていれば、知らせていない中以上の指摘で起こす', () => {
    assert.deepEqual(decideWake(ctx('idle'), []).map((f) => f.key), ['B-DOING-NO-ASSIGNEE:app#1'])
  })

  it('知らせた指摘では起こさない', () => {
    assert.deepEqual(decideWake(ctx('idle'), ['B-DOING-NO-ASSIGNEE:app#1']), [])
  })

  it('TechLead が作業中なら起こさない (フックで入る)', () => {
    assert.deepEqual(decideWake(ctx('busy'), []), [])
  })
})

describe('hasPending', () => {
  it('TechLead が作業中で、知らせていない指摘があれば印を置く', () => {
    assert.equal(hasPending(ctx('busy'), []), true)
  })

  it('知らせていなければ空いていても印は置かない (起こすので)', () => {
    assert.equal(hasPending(ctx('idle'), []), false)
  })

  it('知らせた指摘しか無ければ印を置かない', () => {
    assert.equal(hasPending(ctx('busy'), ['B-DOING-NO-ASSIGNEE:app#1']), false)
  })
})

describe('transitions', () => {
  const finding = makeFinding({ rule: 'B-X', subject: 'app#1', severity: 'medium', message: 'm' })
  const t0 = new Date('2026-10-08T05:00:00.000Z')
  const t1 = new Date('2026-10-08T05:30:00.000Z')

  it('指摘の始まりと終わりを、続いた分数つきで記録する', () => {
    const first = transitions({ open: {}, members: {} }, [finding], [], t0)
    assert.deepEqual(first.events.map((e) => e.type), ['finding-opened'])
    const second = transitions(first.next, [], [], t1)
    assert.deepEqual(second.events, [{ at: t1.toISOString(), type: 'finding-closed', key: 'B-X:app#1', rule: 'B-X', subject: 'app#1', minutes: 30 }])
  })

  it('部下の状態の変わり目を、前の状態の分数つきで記録する', () => {
    const idle: MemberState = { name: 'SWE1', state: 'idle', since: t0.toISOString() }
    const first = transitions({ open: {}, members: {} }, [], [idle], t0)
    assert.deepEqual(first.events, [])
    const busy: MemberState = { name: 'SWE1', state: 'busy', since: t1.toISOString() }
    const second = transitions(first.next, [], [busy], t1)
    assert.deepEqual(second.events, [{ at: t1.toISOString(), type: 'member-state', name: 'SWE1', from: 'idle', to: 'busy', minutes: 30 }])
  })
})

describe('formatReport', () => {
  const events: readonly MetricsEvent[] = [
    { at: '2026-10-08T05:00:00.000Z', type: 'finding-closed', key: 'k1', rule: 'B-X', subject: 'app#1', minutes: 30 },
    { at: '2026-10-08T05:10:00.000Z', type: 'finding-closed', key: 'k2', rule: 'B-X', subject: 'app#2', minutes: 90 },
    { at: '2026-10-08T05:20:00.000Z', type: 'member-state', name: 'SWE1', from: 'idle', to: 'busy', minutes: 40 },
    { at: '2026-10-08T05:30:00.000Z', type: 'stop-blocked', keys: ['k3'] },
    { at: '2026-10-01T05:30:00.000Z', type: 'stop-blocked', keys: ['old'] },
  ]

  it('期間の中の指摘の滞留、部下の空き、止めた回数をまとめる', () => {
    const text = formatReport(events, new Date('2026-10-08T00:00:00.000Z'))
    assert.match(text, /B-X: 直した 2 件、平均 60 分、最長 90 分/)
    assert.match(text, /SWE1: 空き 40 分/)
    assert.match(text, /ターンの終わりを止めた: 1 回/)
  })
})

describe('install', () => {
  const bin = '/opt/scrum-harness/bin/scrum'
  const existing = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '~/.claude/hooks/stop-notify.sh' }] }] }, model: 'opus' }

  it('既存のフックを残してフックを足す', () => {
    const next = withHooks(existing, bin) as unknown as { hooks: Record<string, { hooks: { command: string; asyncRewake?: boolean }[] }[]>; model: string }
    assert.equal(next.model, 'opus')
    assert.equal(next.hooks.Stop?.[0]?.hooks[0]?.command, '~/.claude/hooks/stop-notify.sh')
    const commands = Object.values(next.hooks).flat().flatMap((group) => group.hooks.map((hook) => hook.command))
    assert.ok(commands.includes(`${bin} hook PostToolUse`))
    assert.ok(Object.values(next.hooks).flat().some((g) => g.hooks.some((h) => h.asyncRewake === true && h.command === `${bin} watch`)))
  })

  it('二度足しても重ならない', () => {
    const once = withHooks(existing, bin)
    assert.deepEqual(withHooks(once, bin), once)
  })

  it('外すと元に戻る', () => {
    assert.deepEqual(withoutHooks(withHooks(existing, bin)), existing)
  })

  it('目印は scrum-harness', () => {
    assert.equal(MARKER, 'scrum-harness')
  })
})
