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
    snapshot: snapshot([issue(1, { status: 'In Progress' }), issue(2, { reason: null })]),
    members: [{ name: 'TechLead', state: techleadState, since: NOW.toISOString() }],
    acks: [],
    config,
    now: NOW,
  }
}

describe('decideWake', () => {
  it('when the TechLead is idle, wakes them with an unannounced finding of medium or higher', () => {
    assert.deepEqual(decideWake(ctx('idle'), []).map((f) => f.key), ['B-DOING-NO-ASSIGNEE:app#1'])
  })

  it('does not wake them for an announced finding', () => {
    assert.deepEqual(decideWake(ctx('idle'), ['B-DOING-NO-ASSIGNEE:app#1']), [])
  })

  it('does not wake the TechLead when they are busy (the hook delivers it)', () => {
    assert.deepEqual(decideWake(ctx('busy'), []), [])
  })
})

describe('hasPending', () => {
  it('when the TechLead is busy and there is an unannounced finding, places a marker', () => {
    assert.equal(hasPending(ctx('busy'), []), true)
  })

  it('places no marker when nothing was announced, even if idle (they will be woken)', () => {
    assert.equal(hasPending(ctx('idle'), []), false)
  })

  it('places no marker when there are only announced findings', () => {
    assert.equal(hasPending(ctx('busy'), ['B-DOING-NO-ASSIGNEE:app#1']), false)
  })
})

describe('transitions', () => {
  const finding = makeFinding({ rule: 'B-X', subject: 'app#1', severity: 'medium', message: 'm' })
  const t0 = new Date('2026-10-08T05:00:00.000Z')
  const t1 = new Date('2026-10-08T05:30:00.000Z')

  it('records the start and end of a finding with the minutes it lasted', () => {
    const first = transitions({ open: {}, members: {} }, [finding], [], t0)
    assert.deepEqual(first.events.map((e) => e.type), ['finding-opened'])
    const second = transitions(first.next, [], [], t1)
    assert.deepEqual(second.events, [{ at: t1.toISOString(), type: 'finding-closed', key: 'B-X:app#1', rule: 'B-X', subject: 'app#1', minutes: 30 }])
  })

  it("records a change in a member's state with the minutes spent in the previous state", () => {
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

  it('summarizes how long findings stayed open, member idle time, and the number of stops within the period', () => {
    const text = formatReport(events, new Date('2026-10-08T00:00:00.000Z'))
    assert.match(text, /B-X: fixed 2, mean 60 min, longest 90 min/)
    assert.match(text, /SWE1: idle 40 min/)
    assert.match(text, /Turn endings blocked: 1/)
  })
})

describe('install', () => {
  const bin = '/opt/scrum-harness/bin/scrum'
  const existing = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '~/.claude/hooks/stop-notify.sh' }] }] }, model: 'opus' }

  it('adds hooks while keeping the existing hooks', () => {
    const next = withHooks(existing, bin) as unknown as { hooks: Record<string, { hooks: { command: string; asyncRewake?: boolean }[] }[]>; model: string }
    assert.equal(next.model, 'opus')
    assert.equal(next.hooks.Stop?.[0]?.hooks[0]?.command, '~/.claude/hooks/stop-notify.sh')
    const commands = Object.values(next.hooks).flat().flatMap((group) => group.hooks.map((hook) => hook.command))
    assert.ok(commands.includes(`${bin} hook PostToolUse`))
    assert.ok(commands.includes(`${bin} hook StopFailure`), 'a turn that ended because the subscription refused it is seen')
    assert.ok(Object.values(next.hooks).flat().some((g) => g.hooks.some((h) => h.asyncRewake === true && h.command === `${bin} watch`)))
  })

  it('adding twice does not duplicate them', () => {
    const once = withHooks(existing, bin)
    assert.deepEqual(withHooks(once, bin), once)
  })

  it('removing restores the original', () => {
    assert.deepEqual(withoutHooks(withHooks(existing, bin)), existing)
  })

  it('the marker is scrum-harness', () => {
    assert.equal(MARKER, 'scrum-harness')
  })
})
