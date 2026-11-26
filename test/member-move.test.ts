import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeLauncher } from '../src/adapters/claude-code/launch.ts'
import { codexLauncher } from '../src/adapters/codex/launch.ts'
import type { Config } from '../src/config.ts'
import { memberCommand, type WatchdogDeps } from '../src/members/command.ts'
import { parseLaunch } from '../src/members/config.ts'
import { readMemberSources, recordMemberSource } from '../src/members/funding.ts'
import type { FundingPick, FundingSource, LaunchPlan } from '../src/ports/index.ts'
import { paths, type Paths } from '../src/store.ts'
import type { SessionSignal } from '../src/team/types.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, NOW } from './helpers.ts'

const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString()
const signal = (name: string, extra: Partial<SessionSignal> = {}): SessionSignal => ({ sessionId: `sess-${name}-0001`, name, state: 'idle', since: ago(300), updatedAt: ago(300), isAlive: true, nameSince: null, ...extra })

const ONE: FundingSource = { source: 'one', tool: 'claude', env: {}, overThreshold: true, blocked: false }
const TWO: FundingSource = { source: 'two', tool: 'claude', env: { CLAUDE_CONFIG_DIR: '/accounts/two' }, overThreshold: false, blocked: false }
const PICK_TWO: FundingPick = { state: 'ok', source: 'two', env: { CLAUDE_CONFIG_DIR: '/accounts/two' }, reason: 'one is at 83%' }

type World = {
  readonly members?: Record<string, Record<string, unknown>>
  readonly signals?: readonly SessionSignal[]
  readonly sources?: readonly FundingSource[]
  readonly pick?: FundingPick | (() => FundingPick)
  readonly recorded?: readonly string[]
  readonly hasHooks?: boolean
  readonly hasTranscript?: boolean
  readonly windowStays?: boolean
  readonly startThrows?: (plan: LaunchPlan) => boolean
  readonly flags?: Record<string, true>
  readonly signalsAtMove?: readonly SessionSignal[]
}

describe('moving a member to the account the node picks', () => {
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-move-')))
  })

  function run(world: World = {}, args: readonly string[] = ['move']) {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-move-dir-'))
    const specs = Object.fromEntries(Object.entries(world.members ?? { SWE1: {}, SWE2: {} }).map(([name, spec]) => [name, { dir, ...spec }]))
    const config: Config = { ...base, members: Object.keys(specs), launch: parseLaunch({ tmuxSession: 'team', funding: { command: ['/usr/local/bin/agency'] }, members: specs }) }
    for (const name of world.recorded ?? Object.keys(specs)) recordMemberSource(p.memberSources, { name, source: 'one', state: 'ok', at: ago(3600) })
    const calls: string[] = []
    const started: LaunchPlan[] = []
    let asked = false
    const signals = world.signals ?? Object.keys(specs).map((name) => signal(name))
    const ports = fakePorts({
      members: {
        windows: () => ['home', ...Object.keys(specs).filter((name) => name !== args[1] || world.windowStays === true || !asked)],
        start: (_s: string, plan: LaunchPlan) => {
          if (world.startThrows?.(plan) === true) throw new Error('tmux refused')
          started.push(plan)
        },
        stop: (_s: string, name: string, how: string) => void (calls.push(`${name}:${how}`), (asked = true)),
        screen: () => null,
        press: () => undefined,
      },
      sessions: { find: () => ({ name: null, pid: null }), signals: () => signals },
      funding: () => (typeof world.pick === 'function' ? world.pick() : (world.pick ?? PICK_TWO)),
      fundingSources: () => world.sources ?? [ONE, TWO],
      hasHooksIn: () => world.hasHooks ?? true,
      hasTranscriptIn: () => world.hasTranscript ?? true,
      launchers: { 'claude-code': claudeCodeLauncher, codex: codexLauncher },
    })
    let at = NOW.getTime()
    const deps: WatchdogDeps = { startFailuresPath: p.startFailures, memberSourcesPath: p.memberSources, now: () => new Date(at), sleep: (ms) => void (at += ms), signals: () => world.signalsAtMove ?? signals }
    const text = memberCommand(config, ports, args, world.flags ?? {}, deps)
    return { text, calls, started }
  }

  it('stops an idle member that runs on a source past its threshold, and starts it again on the picked one with --resume and a handoff note', () => {
    const { text, calls, started } = run({}, ['move', 'SWE1'])
    assert.deepEqual(calls, ['SWE1:graceful'])
    assert.equal(started.length, 1)
    const { argv, env } = started[0] as LaunchPlan
    assert.equal(env.CLAUDE_CONFIG_DIR, '/accounts/two')
    assert.deepEqual(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2), ['--resume', 'sess-SWE1-0001'])
    assert.match(argv.at(-1) ?? '', /^You were moved to another login .* carry on with what you were doing\.$/)
    assert.match(text, /SWE1: moves: one is past its threshold; two is not\nSWE1: moved from one to two, conversation continued/)
    assert.equal(readMemberSources(p.memberSources).find((one) => one.name === 'SWE1')?.source, 'two')
  })

  it('moves only one member per call, and says which is next', () => {
    const { text, calls } = run()
    assert.deepEqual(calls, ['SWE1:graceful'])
    assert.match(text, /SWE2: stays: .*one member is moved per call; this one is next/)
  })

  it('changes nothing on --dry-run, and says what it would do', () => {
    const { text, calls, started } = run({ flags: { 'dry-run': true } })
    assert.deepEqual([calls, started], [[], []])
    assert.match(text, /SWE1: would move: one is past its threshold/)
  })

  const stays: readonly (readonly [string, World, RegExp])[] = [
    ['its source is still under its threshold', { sources: [{ ...ONE, overThreshold: false }, TWO] }, /one is still under its threshold/],
    ['the node does not say whether its source is past its threshold', { sources: [{ source: 'one', tool: 'claude', env: {} }, TWO] }, /does not say whether one is past its threshold/],
    ['there is no better source', { pick: { state: 'overThreshold', source: 'one', env: {} } }, /no better source \(the node says overThreshold\)/],
    ['it already is on the picked source', { pick: { state: 'ok', source: 'one', env: {} } }, /already on one/],
    ['no record says where it started', { recorded: [] }, /no record of the source it started on/],
    ['it is pinned to its own configuration directory', { members: { SWE1: { configDir: '/accounts/own' }, SWE2: {} } }, /pinned to \/accounts\/own/],
    ['it is a Codex member', { members: { SWE1: { product: 'codex' }, SWE2: {} } }, /a Codex member is not moved/],
    ['it is busy', { signals: [signal('SWE1', { state: 'busy' }), signal('SWE2')] }, /not idle for 60 seconds \(busy\)/],
    ['it went idle a moment ago', { signals: [signal('SWE1', { since: ago(20) }), signal('SWE2')] }, /not idle for 60 seconds \(idle\)/],
    ['its conversation is not visible under the new login', { hasTranscript: false }, /not visible under \/accounts\/two.*link that directory's projects/],
    ['the new login has no harness hooks', { hasHooks: false }, /no harness hooks.*scrum install --dir/],
  ]
  for (const [title, world, pattern] of stays) {
    it(`leaves it when ${title}`, () => {
      const { text, calls, started } = run(world, ['move', 'SWE1'])
      assert.deepEqual([calls, started], [[], []])
      assert.match(text, /SWE1: stays: /)
      assert.match(text, pattern)
    })
  }

  it('leaves the lead out unless it is named', () => {
    const lead = base.techlead
    const withLead = { members: { [lead]: {}, SWE1: {} } }
    const unnamed = run(withLead)
    assert.doesNotMatch(unnamed.text, new RegExp(`^${lead}:`, 'm'))
    assert.deepEqual(unnamed.calls, ['SWE1:graceful'])
    assert.equal(run(withLead, ['move', lead]).calls[0], `${lead}:graceful`)
  })

  it('does not move a member that went busy since it was looked at', () => {
    const { text, calls } = run({ signalsAtMove: [signal('SWE1', { state: 'busy' }), signal('SWE2')] }, ['move', 'SWE1'])
    assert.deepEqual(calls, [])
    assert.match(text, /SWE1: became busy; not moved/)
  })

  it('leaves a member that does not exit in time running, and does not start a second one', () => {
    const { text, started } = run({ windowStays: true }, ['move', 'SWE1'])
    assert.equal(started.length, 0)
    assert.match(text, /SWE1: asked to exit, and still runs after 15 seconds .*; not moved/)
  })

  it('starts it again on the old login when it does not come up on the new one', () => {
    const { text, started } = run({ startThrows: (plan) => plan.env.CLAUDE_CONFIG_DIR === '/accounts/two' }, ['move', 'SWE1'])
    assert.equal(started.length, 1)
    assert.equal(started[0]?.env.CLAUDE_CONFIG_DIR, undefined)
    assert.match(text, /SWE1: did not come up on two \(tmux refused\); started again on one/)
    assert.equal(readMemberSources(p.memberSources).find((one) => one.name === 'SWE1')?.source, 'one')
  })

  it('says so when it comes up on neither login', () => {
    const { text } = run({ startThrows: () => true }, ['move', 'SWE1'])
    assert.match(text, /did not come up on two \(tmux refused\), and not on one either \(tmux refused\); look at the tmux session/)
  })

  it('moves nothing when the node cannot be asked', () => {
    const { text, calls } = run({ pick: () => { throw new Error('agency failed (exit 1)') } })
    assert.deepEqual(calls, [])
    assert.match(text, /the node cannot be asked, so nothing is moved: agency failed/)
  })
})
