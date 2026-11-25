import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { quote, serviceOf, systemdScheduler, timerOf, unitDir, unitOf } from '../src/adapters/linux/systemd.ts'
import { JOB, recordingRun, setupIn } from './schedule-fixtures.ts'

const SETUP = setupIn({ home: '/home/alice', scrumDir: '/opt/scrum-harness', stateDir: '/home/alice/.claude/scrum' })

describe('the systemd units', () => {
  it('writes the service that runs bin/scrum alerts once, with the PATH of the job', () => {
    assert.equal(
      serviceOf(JOB, SETUP),
      `[Unit]
Description=scrum-harness alerts

[Service]
Type=oneshot
WorkingDirectory=/opt/scrum-harness
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
ExecStart="/opt/scrum-harness/bin/scrum" "alerts"
UMask=0077
Nice=10
IOSchedulingClass=idle
StandardOutput=append:/home/alice/.claude/scrum/log/alerts-systemd.log
StandardError=append:/home/alice/.claude/scrum/log/alerts-systemd.log
`,
    )
  })

  it('writes the timer: first run 5 minutes after it starts, then every 5 minutes after the last run', () => {
    assert.equal(
      timerOf(JOB, SETUP),
      `[Unit]
Description=Run scrum-harness alerts every 300 seconds

[Timer]
OnActiveSec=300s
OnUnitActiveSec=300s
AccuracySec=30s

[Install]
WantedBy=timers.target
`,
    )
  })

  it('hands on a custom state directory, and names the team', () => {
    const team = { ...SETUP, instance: 'lab', isCustomStateDir: true, stateDir: '/srv/teams/lab' }
    assert.match(serviceOf(JOB, team), /Environment="SCRUM_STATE_DIR=\/srv\/teams\/lab"/)
    assert.match(serviceOf(JOB, team), /append:\/srv\/teams\/lab\/log\/alerts-systemd\.log/)
    assert.equal(unitOf(JOB, team), 'scrum-harness-lab-alerts')
    assert.equal(unitOf(JOB, SETUP), 'scrum-harness-alerts')
  })

  it('quotes what systemd reads specially: quotes, backslashes, % and $ in an Exec word, % only in an Environment value', () => {
    assert.equal(quote('a "b" \\c %h $HOME'), '"a \\"b\\" \\\\c %%h $$HOME"')
    const service = serviceOf(JOB, { ...SETUP, scrumDir: '/opt/my dir/100%', path: '/a:/b$c' })
    assert.match(service, /WorkingDirectory=\/opt\/my dir\/100%%$/m)
    assert.match(service, /ExecStart="\/opt\/my dir\/100%%\/bin\/scrum" "alerts"/)
    assert.match(service, /Environment="PATH=\/a:\/b\$c"/)
  })

  it('puts the unit files in XDG_CONFIG_HOME when it is set, else in ~/.config', () => {
    assert.equal(unitDir('/home/alice', undefined), '/home/alice/.config/systemd/user')
    assert.equal(unitDir('/home/alice', ''), '/home/alice/.config/systemd/user')
    assert.equal(unitDir('/home/alice', '/xdg'), '/xdg/systemd/user')
  })
})

describe('installing under systemd', () => {
  it('writes both units, reloads, and starts the timer', () => {
    const setup = setupIn()
    const { run, calls } = recordingRun()
    const message = systemdScheduler(run, undefined).install(JOB, setup)
    const dir = join(setup.home, '.config', 'systemd', 'user')
    assert.equal(readFileSync(join(dir, 'scrum-harness-alerts.service'), 'utf8'), serviceOf(JOB, setup))
    assert.equal(readFileSync(join(dir, 'scrum-harness-alerts.timer'), 'utf8'), timerOf(JOB, setup))
    assert.deepEqual(calls, [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'scrum-harness-alerts.timer']])
    assert.match(message, /enable-linger/)
  })

  it('stops with systemctl\'s own message when it fails', () => {
    assert.throws(() => systemdScheduler(recordingRun(['enable']).run, undefined).install(JOB, setupIn()), /systemctl --user enable .* failed: failed on purpose/)
  })

  it('stops the timer and removes the files', () => {
    const setup = setupIn()
    systemdScheduler(recordingRun().run, undefined).install(JOB, setup)
    const { run, calls } = recordingRun()
    systemdScheduler(run, undefined).uninstall(JOB, setup)
    assert.deepEqual(calls, [['systemctl', '--user', 'disable', '--now', 'scrum-harness-alerts.timer'], ['systemctl', '--user', 'daemon-reload']])
    assert.equal(existsSync(join(setup.home, '.config', 'systemd', 'user', 'scrum-harness-alerts.timer')), false)
    assert.equal(existsSync(join(setup.home, '.config', 'systemd', 'user', 'scrum-harness-alerts.service')), false)
  })

  it('says so when the timer is not active, and shows the schedule when it is', () => {
    const setup = setupIn()
    assert.match(systemdScheduler(recordingRun(['is-active'], { 'is-active': 'inactive\n' }).run, undefined).status(JOB, setup), /scrum-harness-alerts\.timer is inactive/)
    const active = recordingRun([], { 'list-timers': 'NEXT LEFT\nsoon 4min\n', show: 'Result=success\nExecMainStatus=0\n' })
    const text = systemdScheduler(active.run, undefined).status(JOB, setup)
    assert.match(text, /is active\nNEXT LEFT\nsoon 4min\nResult=success\nExecMainStatus=0/)
  })
})
