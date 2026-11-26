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
import type { FundingSource, LaunchPlan } from '../src/ports/index.ts'
import { paths, type Paths } from '../src/store.ts'
import type { SessionSignal } from '../src/team/types.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, NOW } from './helpers.ts'

const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString()
const signal = (name: string, extra: Partial<SessionSignal> = {}): SessionSignal => ({ sessionId: `sess-${name}-0001`, name, state: 'idle', since: ago(300), updatedAt: ago(300), isAlive: true, nameSince: null, ...extra })

const DEFAULT: FundingSource = { source: 'one', tool: 'claude', env: {} }
const OTHER: FundingSource = { source: 'two', tool: 'claude', env: { CLAUDE_CONFIG_DIR: '/accounts/two' } }

describe('members that run, and members that start again', () => {
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-adopt-')))
  })

  type World = {
    readonly members?: Record<string, Record<string, unknown>>
    readonly running?: readonly string[]
    readonly signals?: readonly SessionSignal[]
    /** What the hooks' heartbeats say, which stay after a session exits (the session records of the sessions directory do not) */
    readonly heartbeats?: readonly SessionSignal[]
    readonly sources?: readonly FundingSource[]
    readonly hasTranscript?: boolean
    readonly pickEnv?: Record<string, string>
  }

  function run(world: World, args: readonly string[], flags: Record<string, string | true> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-adopt-dir-'))
    const specs = Object.fromEntries(Object.entries(world.members ?? { SWE1: {}, SWE2: {} }).map(([name, spec]) => [name, { dir, ...spec }]))
    const config: Config = { ...base, members: Object.keys(specs), launch: parseLaunch({ tmuxSession: 'team', funding: { command: ['/usr/local/bin/agency'] }, members: specs }) }
    const started: LaunchPlan[] = []
    const ports = fakePorts({
      members: { windows: () => ['home', ...(world.running ?? ['SWE1', 'SWE2'])], start: (_s: string, plan: LaunchPlan) => void started.push(plan), stop: () => undefined, screen: () => null, press: () => undefined },
      sessions: { find: () => ({ name: null, pid: null }), signals: () => world.signals ?? [signal('SWE1'), signal('SWE2')] },
      fundingSources: () => world.sources ?? [DEFAULT, OTHER],
      funding: world.pickEnv === undefined ? null : () => ({ state: 'ok', source: 'two', env: world.pickEnv ?? {} }),
      hasTranscriptIn: () => world.hasTranscript ?? true,
      launchers: { 'claude-code': claudeCodeLauncher, codex: codexLauncher },
    })
    const heard = world.heartbeats ?? world.signals ?? [signal('SWE1'), signal('SWE2')]
    const deps: WatchdogDeps = { startFailuresPath: p.startFailures, memberSourcesPath: p.memberSources, now: () => NOW, sleep: () => undefined, signals: () => heard }
    return { text: memberCommand(config, ports, args, flags, deps), started }
  }

  describe('adopt', () => {
    it('records a running member as on the default login, from its live session, and restarts nothing', () => {
      const { text, started } = run({}, ['adopt', 'SWE1'])
      assert.match(text, /SWE1: adopted on one \(it keeps running; nothing was restarted\)/)
      assert.deepEqual(started, [])
      assert.deepEqual(readMemberSources(p.memberSources).map((one) => [one.name, one.source, one.state]), [['SWE1', 'one', 'ok']])
    })

    it('records the source that is named, when the member is not on the default login', () => {
      run({}, ['adopt', 'SWE1'], { source: 'two' })
      assert.equal(readMemberSources(p.memberSources)[0]?.source, 'two')
      assert.match(run({}, ['adopt', 'SWE1'], { source: 'nope' }).text, /the node lists no Claude source named nope \(it lists: one, two\)/)
    })

    it('needs the one default-login source, or --source', () => {
      assert.match(run({ sources: [OTHER] }, ['adopt', 'SWE1']).text, /does not list exactly one Claude source on the default login; say which with --source/)
      assert.match(run({ sources: [DEFAULT, { ...DEFAULT, source: 'dup' }] }, ['adopt', 'SWE1']).text, /exactly one Claude source/)
    })

    it('leaves a member alone that is already recorded, one that does not run, one without a live session, and one that is not configured', () => {
      recordMemberSource(p.memberSources, { name: 'SWE1', source: 'two', state: 'ok', at: ago(60) })
      assert.match(run({}, ['adopt', 'SWE1']).text, /SWE1: already recorded on two; left alone/)
      assert.match(run({ running: ['SWE1'], signals: [signal('SWE1')] }, ['adopt', 'SWE2']).text, /SWE2: does not run, so there is nothing to adopt/)
      assert.match(run({ signals: [signal('SWE2', { state: 'ended', isAlive: false })] }, ['adopt', 'SWE2']).text, /SWE2: has no live session record to adopt/)
      assert.match(run({}, ['adopt', 'Nobody']).text, /Nobody: not in the configuration/)
      assert.equal(readMemberSources(p.memberSources).find((one) => one.name === 'SWE1')?.source, 'two')
    })

    it('adopts every running member that has no record with --all, and says when there is none', () => {
      recordMemberSource(p.memberSources, { name: 'SWE1', source: 'two', state: 'ok', at: ago(60) })
      assert.match(run({}, ['adopt'], { all: true }).text, /^SWE2: adopted on one/)
      assert.equal(run({}, ['adopt'], { all: true }).text, 'every running member is already recorded')
      assert.match(run({}, ['adopt']).text, /name the members to adopt, or pass --all/)
    })
  })

  describe('start --resume', () => {
    const stopped = { running: [] as string[] }

    it('continues the latest recorded session with --resume and a short note instead of the brief', () => {
      const old = signal('SWE1', { sessionId: 'sess-old-0001', updatedAt: ago(9000), state: 'ended', isAlive: false })
      const last = signal('SWE1', { sessionId: 'sess-last-0001', updatedAt: ago(600), state: 'ended', isAlive: false })
      const { text, started } = run({ ...stopped, signals: [old, last] }, ['start', 'SWE1'], { resume: true, 'no-wait': true })
      assert.match(text, /SWE1: started in/)
      const argv = started[0]?.argv ?? []
      assert.deepEqual(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2), ['--resume', 'sess-last-0001'])
      assert.match(argv.at(-1) ?? '', /^You were started again\./)
    })

    it('finds a stopped member by the hooks\' heartbeat, which stays after Claude Code removes the session record', () => {
      const { started } = run({ ...stopped, signals: [], heartbeats: [signal('SWE1', { sessionId: 'sess-beat-0001', state: 'ended', isAlive: false })] }, ['start', 'SWE1'], { resume: true, 'no-wait': true })
      assert.equal(started[0]?.argv[(started[0]?.argv.indexOf('--resume') ?? -1) + 1], 'sess-beat-0001')
    })

    it('finds an adopted member by the session kept when it was adopted, after its record and heartbeat are gone', () => {
      run({ signals: [signal('SWE1', { sessionId: 'sess-adopted-0001' }), signal('SWE2')] }, ['adopt', 'SWE1'])
      assert.equal(readMemberSources(p.memberSources)[0]?.sessionId, 'sess-adopted-0001')
      const { started } = run({ ...stopped, signals: [] }, ['start', 'SWE1'], { resume: true, 'no-wait': true })
      assert.equal(started[0]?.argv[(started[0]?.argv.indexOf('--resume') ?? -1) + 1], 'sess-adopted-0001')
    })

    it('prefers a newer session over the one kept at adoption', () => {
      run({ signals: [signal('SWE1', { sessionId: 'sess-adopted-0001' }), signal('SWE2')] }, ['adopt', 'SWE1'])
      const newer = signal('SWE1', { sessionId: 'sess-newer-0001', updatedAt: ago(10), state: 'ended', isAlive: false })
      const { started } = run({ ...stopped, signals: [newer] }, ['start', 'SWE1'], { resume: true, 'no-wait': true })
      assert.equal(started[0]?.argv[(started[0]?.argv.indexOf('--resume') ?? -1) + 1], 'sess-newer-0001')
    })

    it('starts a new conversation without --resume', () => {
      const { started } = run({ ...stopped, signals: [signal('SWE1', { state: 'ended', isAlive: false })] }, ['start', 'SWE1'], { 'no-wait': true })
      assert.equal(started[0]?.argv.includes('--resume'), false)
    })

    it('refuses when there is no recorded session, when it is not visible under the login, and for a Codex member', () => {
      assert.match(run({ ...stopped, signals: [] }, ['start', 'SWE1'], { resume: true }).text, /SWE1: not started: SWE1 has no recorded session to continue/)
      const ended = [signal('SWE1', { state: 'ended', isAlive: false })]
      assert.match(run({ ...stopped, signals: ended, hasTranscript: false }, ['start', 'SWE1'], { resume: true }).text, /not started: its last conversation is not visible under .*claude.*link that directory's projects/)
      assert.match(run({ ...stopped, members: { SWE1: { product: 'codex' } }, signals: ended }, ['start', 'SWE1'], { resume: true }).text, /a Codex member is not resumed/)
    })

    it('looks for the conversation under the login the node picked', () => {
      const seen: string[] = []
      const dir = mkdtempSync(join(tmpdir(), 'scrum-adopt-dir-'))
      const config: Config = { ...base, members: ['SWE1'], launch: parseLaunch({ tmuxSession: 'team', funding: { command: ['/usr/local/bin/agency'] }, members: { SWE1: { dir } } }) }
      const ports = fakePorts({
        members: { windows: () => ['home'], start: () => undefined, stop: () => undefined, screen: () => null, press: () => undefined },
        sessions: { find: () => ({ name: null, pid: null }), signals: () => [signal('SWE1', { state: 'ended', isAlive: false })] },
        funding: () => ({ state: 'ok', source: 'two', env: { CLAUDE_CONFIG_DIR: '/accounts/two' } }),
        hasTranscriptIn: (configDir: string) => (seen.push(configDir), true),
        launchers: { 'claude-code': claudeCodeLauncher, codex: codexLauncher },
      })
      memberCommand(config, ports, ['start', 'SWE1'], { resume: true, 'no-wait': true }, { startFailuresPath: p.startFailures, now: () => NOW, sleep: () => undefined, signals: () => [signal('SWE1', { state: 'ended', isAlive: false })] })
      assert.deepEqual(seen, ['/accounts/two'])
    })
  })
})
