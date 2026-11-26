import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeLauncher } from '../src/adapters/claude-code/launch.ts'
import { codexLauncher } from '../src/adapters/codex/launch.ts'
import { tmuxHost } from '../src/adapters/tmux/host.ts'
import { parseConfig, type Config } from '../src/config.ts'
import { memberCommand } from '../src/members/command.ts'
import { parseLaunch } from '../src/members/config.ts'
import { formatReport, memberReport } from '../src/members/list.ts'
import { planMember } from '../src/members/plan.ts'
import type { LaunchPlan } from '../src/ports/index.ts'
import type { SessionSignal } from '../src/team/types.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base } from './helpers.ts'

const LAUNCHERS = { 'claude-code': claudeCodeLauncher, codex: codexLauncher }
const LAUNCH = {
  tmuxSession: 'team',
  defaults: { model: 'model-a', effort: 'high' },
  members: { SWE1: { dir: '~/work/swe1', brief: '/briefs/SWE1.txt' }, SWE2: { dir: '/work/swe2', model: 'model-b', permissions: 'skip' } },
  ignoreWindows: ['home'],
}
const config: Config = { ...base, launch: parseLaunch(LAUNCH) }

const signal = (name: string, state: SessionSignal['state'], isAlive = true): SessionSignal => ({ sessionId: `s-${name}`, name, state, since: '2026-10-08T05:00:00.000Z', updatedAt: '2026-10-08T05:00:00.000Z', isAlive, nameSince: '2026-10-08T04:00:00.000Z' })

describe('the launch section', () => {
  it('reads the tmux session, the defaults, the members, and the windows to ignore', () => {
    assert.deepEqual(parseLaunch(LAUNCH)?.members.SWE2, { dir: '/work/swe2', model: 'model-b', permissions: 'skip' })
    assert.deepEqual([parseLaunch(LAUNCH)?.tmuxSession, parseLaunch(LAUNCH)?.defaults, parseLaunch(LAUNCH)?.ignoreWindows], ['team', { model: 'model-a', effort: 'high' }, ['home']])
    assert.deepEqual(parseLaunch({ tmuxSession: 'team', members: {} })?.ignoreWindows, [])
  })

  const refused: readonly (readonly [string, unknown])[] = [
    ['no section', undefined],
    ['a tmux session that is not a plain name (it would be a tmux target)', { ...LAUNCH, tmuxSession: 'a:b' }],
    ['a relative directory', { ...LAUNCH, members: { SWE1: { dir: 'work/swe1' } } }],
    ['a key that is not known (a misspelling would be ignored)', { ...LAUNCH, members: { SWE1: { directory: '/x' } } }],
    ['a product that is not supported', { ...LAUNCH, members: { SWE1: { product: 'other' } } }],
    ['permissions that are not ask or skip', { ...LAUNCH, members: { SWE1: { permissions: 'all' } } }],
    ['a model with a space', { ...LAUNCH, defaults: { model: 'model a' } }],
    ['a member name with a slash', { ...LAUNCH, members: { 'a/b': {} } }],
    ['ignoreWindows that is not a list of names', { ...LAUNCH, ignoreWindows: 'home' }],
  ]
  for (const [name, raw] of refused) {
    it(`ignores the section for ${name}, so the other features keep working`, () => {
      assert.equal(parseLaunch(raw), undefined)
    })
  }

  it('is carried by the configuration', () => {
    assert.equal(parseConfig({ ...base, launch: LAUNCH })?.launch?.tmuxSession, 'team')
    assert.equal(parseConfig({ ...base, launch: { tmuxSession: 'a:b', members: {} } })?.launch, undefined)
  })
})

describe('the report of what is configured against what runs', () => {
  const named = ['TechLead', 'SWE1', 'SWE2', 'SWE3']

  it('marks a member as running by its window or its live session, and the others as not running', () => {
    const report = memberReport(config, ['TechLead', 'SWE1', 'home'], [signal('SWE2', 'busy'), signal('SWE3', 'idle', false)])
    assert.deepEqual(report.rows.map((row) => [row.name, row.isRunning, row.state]), [['TechLead', true, 'unknown'], ['SWE1', true, 'unknown'], ['SWE2', true, 'busy'], ['SWE3', false, 'unknown']])
    assert.deepEqual(named, report.rows.map((row) => row.name))
  })

  it('lists a window that is not in the configuration, except the ones to ignore', () => {
    const report = memberReport(config, ['TechLead', 'home', 'Stray', 'SWE1'], [])
    assert.deepEqual(report.unlisted, ['Stray'])
  })

  it('names the liaison when alerts name one, once even when it is also a member', () => {
    const withLiaison: Config = { ...config, alerts: { enabled: true, liaison: 'Liaison' } as never }
    assert.deepEqual(memberReport(withLiaison, [], []).rows.map((row) => row.name), [...named, 'Liaison'])
    assert.deepEqual(memberReport({ ...withLiaison, members: ['SWE1', 'Liaison'] }, [], []).rows.map((row) => row.name), ['TechLead', 'SWE1', 'Liaison'])
  })

  it('says so when the host\'s windows could not be read, and judges by the session records only', () => {
    const report = memberReport(config, null, [signal('SWE1', 'idle')])
    assert.equal(report.isHostKnown, false)
    assert.match(formatReport(report), /could not be read/)
    assert.deepEqual(report.rows.find((row) => row.name === 'SWE1')?.isRunning, true)
  })

  it('prints the drift both ways, or that there is none', () => {
    const drifting = formatReport(memberReport(config, ['TechLead', 'SWE1', 'Stray'], [signal('SWE2', 'busy')]))
    assert.match(drifting, /running but not in the configuration: Stray/)
    assert.match(drifting, /listed but not running: SWE3/)
    const calm = formatReport(memberReport({ ...config, members: ['SWE1'] }, ['TechLead', 'SWE1'], []))
    assert.match(calm, /no drift/)
  })
})

describe('the tmux host', () => {
  const run = (status: number | null, stdout = '') => () => ({ status, stdout, stderr: '' })

  it('lists the names of the windows of a session, and asks for that session exactly', () => {
    const calls: string[][] = []
    const host = tmuxHost((command, args) => {
      calls.push([command, ...args])
      return { status: 0, stdout: 'home\nSWE1\n\n', stderr: '' }
    })
    assert.deepEqual(host.windows('team'), ['home', 'SWE1'])
    assert.deepEqual(calls, [['tmux', 'list-windows', '-t', '=team', '-F', '#{window_name}']])
  })

  it('is null when there is no such session, or no tmux', () => {
    assert.equal(tmuxHost(run(1)).windows('team'), null)
    assert.equal(tmuxHost(run(null)).windows('team'), null)
  })
})

describe('scrum member', () => {
  it('lists the report with the host\'s windows and the session records', () => {
    const ports = fakePorts({ members: { windows: (session) => (session === 'team' ? ['TechLead', 'SWE1'] : null), start: () => undefined }, sessions: { find: () => ({ name: null, pid: null }), signals: () => [signal('SWE2', 'waiting')] } })
    const text = memberCommand(config, ports, ['list'])
    assert.match(text, /SWE2\s+member\s+running \(waiting\) \[no window\]/)
    assert.match(text, /listed but not running: SWE3/)
  })

  it('does not ask the host without a launch section, and shows the usage for anything else', () => {
    const ports = fakePorts({ members: { windows: () => assert.fail('the host must not be asked'), start: () => undefined } })
    assert.match(memberCommand(base, ports, ['list']), /could not be read/)
    assert.match(memberCommand(config, ports, []), /scrum member: /)
  })
})

describe('starting a member', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'scrum-member-start-'))
  const SECRET_BRIEF = 'You are SWE1. SECRET-BRIEF-TEXT'

  /** A launch section whose members have real directories and briefs. */
  function launchConfig(extra: Record<string, unknown> = {}): Config {
    const swe1 = dir()
    const briefFile = join(dir(), 'SWE1.txt')
    writeFileSync(briefFile, `${SECRET_BRIEF}\n`)
    const launch = parseLaunch({ tmuxSession: 'team', defaults: { model: 'model-a', effort: 'high' }, members: { SWE1: { dir: swe1, brief: briefFile, ...extra }, SWE2: { dir: dir() } }, ignoreWindows: ['home'] })
    return { ...base, launch }
  }
  const hostOf = (windows: readonly string[] | null, started: LaunchPlan[]) => ({ windows: () => windows, start: (_session: string, plan: LaunchPlan) => void started.push(plan) })
  const portsOf = (windows: readonly string[] | null, started: LaunchPlan[], signals: readonly SessionSignal[] = []) =>
    fakePorts({ members: hostOf(windows, started), launchers: LAUNCHERS, sessions: { find: () => ({ name: null, pid: null }), signals: () => signals } })

  it('plans a member from its settings: the directory, the environment that makes it report to this team, and its product\'s command line', () => {
    const config = launchConfig()
    const planned = planMember(config, 'SWE1', '/state/team', '/usr/bin:/opt/bin', LAUNCHERS)
    assert.ok('plan' in planned)
    assert.deepEqual(planned.plan.argv, ['claude', '-n', 'SWE1', '--model', 'model-a', '--effort', 'high', SECRET_BRIEF])
    assert.deepEqual(planned.plan.env, { SCRUM_STATE_DIR: '/state/team', SCRUM_NAME: 'SWE1', PATH: '/usr/bin:/opt/bin' })
    assert.equal(planned.plan.dir, config.launch?.members.SWE1?.dir)
  })

  it('lets the member\'s own settings win over the defaults, adds its Claude Code configuration directory, and skips prompts only when told', () => {
    const planned = planMember(launchConfig({ model: 'model-b', configDir: '/data/claude-b', permissions: 'skip' }), 'SWE1', '/s', undefined, LAUNCHERS)
    assert.ok('plan' in planned)
    assert.deepEqual(planned.plan.argv.slice(0, 6), ['claude', '--dangerously-skip-permissions', '-n', 'SWE1', '--model', 'model-b'])
    assert.deepEqual(planned.plan.env, { SCRUM_STATE_DIR: '/s', SCRUM_NAME: 'SWE1', CLAUDE_CONFIG_DIR: '/data/claude-b' })
    assert.equal(planMember(launchConfig(), 'SWE1', '/s', undefined, LAUNCHERS).hasOwnProperty('plan'), true)
    const asks = planMember(launchConfig(), 'SWE1', '/s', undefined, LAUNCHERS)
    assert.equal('plan' in asks && asks.plan.argv.includes('--dangerously-skip-permissions'), false)
  })

  it('says what is missing: a directory that is not set or not there, and a brief that cannot be read', () => {
    const config = launchConfig()
    assert.match((planMember(config, 'Nobody', '/s', undefined, LAUNCHERS) as { problem: string }).problem, /has no directory/)
    const gone: Config = { ...config, launch: parseLaunch({ tmuxSession: 'team', members: { SWE1: { dir: '/nonexistent/dir' }, SWE2: { dir: dir(), brief: '/nonexistent/brief.txt' } } }) }
    assert.match((planMember(gone, 'SWE1', '/s', undefined, LAUNCHERS) as { problem: string }).problem, /does not exist: \/nonexistent\/dir/)
    assert.match((planMember(gone, 'SWE2', '/s', undefined, LAUNCHERS) as { problem: string }).problem, /brief of SWE2 cannot be read/)
  })

  it('starts the members named, through the host, in the launch section\'s session', () => {
    const started: LaunchPlan[] = []
    const text = memberCommand(launchConfig(), portsOf(['home'], started), ['start', 'SWE1'], {})
    assert.match(text, /^SWE1: started in /)
    assert.deepEqual(started.map((one) => [one.name, one.env.SCRUM_NAME]), [['SWE1', 'SWE1']])
  })

  it('starts every member that has launch settings with --all, and leaves one that already runs alone', () => {
    const started: LaunchPlan[] = []
    const config = launchConfig()
    const named: Config = { ...config, members: ['SWE1', 'SWE2'] }
    const text = memberCommand(named, portsOf(['home', 'SWE1'], started), ['start'], { all: true })
    assert.match(text, /SWE1: already runs, left alone/)
    assert.match(text, /SWE2: started/)
    assert.deepEqual(started.map((one) => one.name), ['SWE2'])
  })

  it('treats a live session without a window as running too', () => {
    const started: LaunchPlan[] = []
    const live: SessionSignal = { sessionId: 's', name: 'SWE1', state: 'busy', since: '2026-10-08T05:00:00.000Z', updatedAt: '2026-10-08T05:00:00.000Z', isAlive: true, nameSince: '2026-10-08T04:00:00.000Z' }
    assert.match(memberCommand(launchConfig(), portsOf(['home'], started, [live]), ['start', 'SWE1'], {}), /already runs/)
    assert.deepEqual(started, [])
  })

  it('prints what would run with --dry-run, and starts nothing; neither the brief nor the PATH is shown', () => {
    const started: LaunchPlan[] = []
    const text = memberCommand(launchConfig(), portsOf(['home'], started), ['start', 'SWE1'], { 'dry-run': true })
    assert.deepEqual(started, [])
    assert.match(text, /env SCRUM_STATE_DIR=\S+ SCRUM_NAME=SWE1 PATH=<this process's PATH> claude -n SWE1 --model model-a --effort high <brief: \d+ characters>/)
    assert.equal(text.includes('SECRET-BRIEF-TEXT'), false)
  })

  it('refuses a name that is not in the configuration, nothing to start, and no launch section', () => {
    const ports = portsOf(['home'], [])
    assert.match(memberCommand(launchConfig(), ports, ['start', 'Stranger'], {}), /not in the configuration.*Stranger/)
    assert.match(memberCommand(launchConfig(), ports, ['start'], {}), /name the members to start/)
    assert.match(memberCommand(base, ports, ['start', 'SWE1'], {}), /no launch section/)
  })

  it('says what the host refused, and goes on with the others', () => {
    const config: Config = { ...launchConfig(), members: ['SWE1', 'SWE2'] }
    const refusing = fakePorts({ members: { windows: () => ['home'], start: (_s: string, plan: LaunchPlan) => { if (plan.name === 'SWE1') throw new Error('no space for window') } }, launchers: LAUNCHERS })
    const text = memberCommand(config, refusing, ['start', 'SWE1', 'SWE2'], {})
    assert.match(text, /SWE1: could not start: no space for window/)
    assert.match(text, /SWE2: started/)
  })
})

describe('the tmux host starts a window', () => {
  const plan: LaunchPlan = { name: 'SWE1', dir: '/work/swe1', env: { SCRUM_STATE_DIR: '/state', SCRUM_NAME: 'SWE1' }, argv: ['claude', '-n', 'SWE1', 'You are SWE1; do it'] }

  it('creates the session when it is not there, then the window, with the environment and the command as separate words (no shell)', () => {
    const calls: string[][] = []
    tmuxHost((command, args) => {
      calls.push([command, ...args])
      return { status: args[0] === 'has-session' ? 1 : 0, stdout: '', stderr: '' }
    }).start('team', plan)
    assert.deepEqual(calls, [
      ['tmux', 'has-session', '-t', '=team'],
      ['tmux', 'new-session', '-d', '-s', 'team', '-n', 'home', '-c', '/work/swe1'],
      ['tmux', 'new-window', '-d', '-t', '=team', '-n', 'SWE1', '-c', '/work/swe1', 'env', 'SCRUM_STATE_DIR=/state', 'SCRUM_NAME=SWE1', 'claude', '-n', 'SWE1', 'You are SWE1; do it'],
    ])
  })

  it('only adds the window when the session exists, and throws tmux\'s own words when it refuses', () => {
    const calls: string[][] = []
    tmuxHost((command, args) => (calls.push([command, ...args]), { status: 0, stdout: '', stderr: '' })).start('team', plan)
    assert.deepEqual(calls.map((call) => call[1]), ['has-session', 'new-window'])
    const refusing = tmuxHost((_c, args) => ({ status: args[0] === 'new-window' ? 1 : 0, stdout: '', stderr: 'create window failed: index in use' }))
    assert.throws(() => refusing.start('team', plan), /create window failed: index in use/)
  })
})
