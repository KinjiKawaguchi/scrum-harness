import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linuxNotifier, notifySendArgs } from '../src/adapters/linux/notify.ts'
import { systemdScheduler } from '../src/adapters/linux/systemd.ts'
import type { Run } from '../src/adapters/run.ts'
import { macosNotify } from '../src/adapters/macos/notify.ts'
import { ALERTS_JOB, scheduleCommand, SCHEDULE_USAGE } from '../src/schedule/command.ts'
import { scheduleSetup, type SetupInputs } from '../src/schedule/setup.ts'
import { buildNotifier, buildScheduler } from '../src/wiring.ts'
import { recordingRun, setupIn } from './schedule-fixtures.ts'

function buildSchedulerWith(run: Run) {
  return systemdScheduler(run, undefined)
}

describe('choosing the adapters by platform', () => {
  it('uses launchd on macOS and systemd on Linux, and nothing elsewhere', () => {
    assert.equal(buildScheduler('darwin')?.kind, 'launchd')
    assert.equal(buildScheduler('linux')?.kind, 'systemd')
    assert.equal(buildScheduler('win32'), null)
  })

  it('keeps the macOS notifier on macOS and uses the portable one everywhere else', () => {
    assert.equal(buildNotifier('darwin'), macosNotify)
    assert.notEqual(buildNotifier('linux', tmpdir()), macosNotify)
    assert.notEqual(buildNotifier('freebsd', tmpdir()), macosNotify)
  })
})

describe('the notifier without macOS', () => {
  const logPath = () => join(mkdtempSync(join(tmpdir(), 'scrum-notify-')), 'log', 'notifications.log')
  const NOW = () => new Date('2026-11-25T01:02:03.000Z')

  it('shows the notice with notify-send, passing the text after -- so a dash in a title is not an option', () => {
    const { run, calls } = recordingRun()
    const path = logPath()
    linuxNotifier(path, run, NOW)('-Epic stalled', 'body')
    assert.deepEqual(calls, [['notify-send', '--app-name=scrum-harness', '--', '-Epic stalled', 'body']])
    assert.deepEqual(notifySendArgs('t', 'b'), ['--app-name=scrum-harness', '--', 't', 'b'])
    assert.throws(() => readFileSync(path, 'utf8'))
  })

  it('writes one line to the log when notify-send is missing or cannot reach a desktop, and does not throw', () => {
    const { run } = recordingRun(['notify-send'])
    const path = logPath()
    const notify = linuxNotifier(path, run, NOW)
    notify('Epic app#1 stalled', 'line one\nline two\t(tab)')
    notify('Second', 'again')
    assert.equal(readFileSync(path, 'utf8'), '2026-11-25T01:02:03.000Z\tEpic app#1 stalled\tline one line two (tab)\n2026-11-25T01:02:03.000Z\tSecond\tagain\n')
  })
})

describe('working out the job\'s environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'scrum-setup-'))
  const tools = (dir: string, names: readonly string[]) => {
    mkdirSync(join(root, dir), { recursive: true })
    for (const name of names) writeFileSync(join(root, dir, name), '')
    return join(root, dir)
  }
  const inputs = (overrides: Partial<SetupInputs>): SetupInputs => ({
    home: '/home/alice',
    scrumDir: '/opt/scrum-harness',
    stateDir: '/home/alice/.claude/scrum',
    defaultStateDir: '/home/alice/.claude/scrum',
    nodePath: join(root, 'nodebin', 'node'),
    shellPath: '/nowhere',
    instance: '',
    requireGh: true,
    isExecutable: (path) => path.startsWith(root),
    ...overrides,
  })

  it('puts the folders of node and gh, then the system folders, into PATH', () => {
    const gh = tools('ghbin', ['gh'])
    tools('nodebin', ['node'])
    const setup = scheduleSetup(inputs({ shellPath: `/nowhere:${gh}` }))
    assert.deepEqual(typeof setup === 'string' ? setup : setup.path, `${join(root, 'nodebin')}:${gh}:/usr/bin:/bin`)
  })

  it('lists a folder once when node and gh live together', () => {
    const both = tools('nodebin', ['node', 'gh'])
    const setup = scheduleSetup(inputs({ shellPath: both }))
    assert.equal(typeof setup === 'string' ? setup : setup.path, `${both}:/usr/bin:/bin`)
  })

  it('stops when gh is not in PATH, unless the command does not need it', () => {
    assert.match(String(scheduleSetup(inputs({ shellPath: '/nowhere' }))), /gh was not found/)
    const withoutGh = scheduleSetup(inputs({ shellPath: '/nowhere', requireGh: false }))
    assert.equal(typeof withoutGh === 'string' ? withoutGh : withoutGh.path, `${join(root, 'nodebin')}:/usr/bin:/bin`)
  })

  it('stops when node is not executable', () => {
    assert.match(String(scheduleSetup(inputs({ nodePath: '/missing/node', isExecutable: (path) => path.endsWith('/gh'), shellPath: '/x' }))), /node is not executable/)
  })

  it('marks a state directory that is not the default, and checks the team name', () => {
    tools('nodebin', ['node', 'gh'])
    const custom = scheduleSetup(inputs({ shellPath: join(root, 'nodebin'), stateDir: '/srv/teams/lab', instance: 'lab' }))
    assert.deepEqual(typeof custom === 'string' ? custom : [custom.isCustomStateDir, custom.instance], [true, 'lab'])
    for (const bad of ['Lab', 'a b', '-x', 'a/b']) assert.match(String(scheduleSetup(inputs({ shellPath: join(root, 'nodebin'), instance: bad }))), /--name must be/)
  })
})

describe('scrum schedule', () => {
  it('shows the files and installs nothing for print', () => {
    const { run, calls } = recordingRun()
    const result = scheduleCommand('print', buildSchedulerWith(run), setupIn())
    assert.equal(result.ok, true)
    assert.match(result.text, /^# .*scrum-harness-alerts\.service\n\[Unit\]/)
    assert.match(result.text, /scrum-harness-alerts\.timer\n\[Unit\]/)
    assert.deepEqual(calls, [])
  })

  it('refuses an unknown action, a platform without a scheduler, and a setup that failed', () => {
    const scheduler = buildSchedulerWith(recordingRun().run)
    assert.deepEqual(scheduleCommand('start', scheduler, setupIn()), { ok: false, text: SCHEDULE_USAGE })
    assert.match(scheduleCommand('install', null, setupIn()).text, /no scheduler for this platform/)
    assert.deepEqual(scheduleCommand('install', scheduler, 'gh was not found in PATH'), { ok: false, text: 'gh was not found in PATH' })
  })

  it('runs alerts every 5 minutes', () => {
    assert.deepEqual([ALERTS_JOB.args, ALERTS_JOB.everySeconds], [['alerts'], 300])
  })
})
