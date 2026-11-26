import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmuxHost } from '../src/adapters/tmux/host.ts'
import { parseConfig, type Config } from '../src/config.ts'
import { memberCommand } from '../src/members/command.ts'
import { parseLaunch } from '../src/members/config.ts'
import { formatReport, memberReport } from '../src/members/list.ts'
import type { SessionSignal } from '../src/team/types.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base } from './helpers.ts'

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
    const ports = fakePorts({ members: { windows: (session) => (session === 'team' ? ['TechLead', 'SWE1'] : null) }, sessions: { find: () => ({ name: null, pid: null }), signals: () => [signal('SWE2', 'waiting')] } })
    const text = memberCommand(config, ports, ['list'])
    assert.match(text, /SWE2\s+member\s+running \(waiting\) \[no window\]/)
    assert.match(text, /listed but not running: SWE3/)
  })

  it('does not ask the host without a launch section, and shows the usage for anything else', () => {
    const ports = fakePorts({ members: { windows: () => assert.fail('the host must not be asked') } })
    assert.match(memberCommand(base, ports, ['list']), /could not be read/)
    assert.match(memberCommand(config, ports, []), /scrum member: /)
  })
})
