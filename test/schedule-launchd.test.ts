import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { labelOf, launchdScheduler, plistOf } from '../src/adapters/macos/launchd.ts'
import { JOB, recordingRun, setupIn } from './schedule-fixtures.ts'

const read = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/launchd/${name}`, import.meta.url)), 'utf8')

describe('the launchd launch agent', () => {
  it('is the same file the template of the earlier scripts produced', () => {
    const setup = setupIn({ home: '/home/alice', scrumDir: '/opt/scrum-harness', stateDir: '/home/alice/.claude/scrum' })
    assert.equal(plistOf(JOB, setup), read('alerts.rendered.plist'))
  })

  it('runs bin/scrum alerts every 5 minutes and not right after being loaded', () => {
    const plist = plistOf(JOB, setupIn())
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/)
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/)
    assert.match(plist, /<string>\/opt\/scrum-harness\/bin\/scrum<\/string>\s*<string>alerts<\/string>/)
  })

  it('names the state directory only when it is not the default one', () => {
    assert.doesNotMatch(plistOf(JOB, setupIn()), /SCRUM_STATE_DIR/)
    const custom = plistOf(JOB, setupIn({ isCustomStateDir: true, stateDir: '/srv/teams/app' }))
    assert.match(custom, /<key>SCRUM_STATE_DIR<\/key>\s*<string>\/srv\/teams\/app<\/string>/)
    assert.match(custom, /<string>\/srv\/teams\/app\/log\/alerts-launchd\.log<\/string>/)
  })

  it('gives each team on a machine its own label', () => {
    assert.equal(labelOf(JOB, setupIn()), 'local.scrum-harness.alerts')
    assert.equal(labelOf(JOB, setupIn({ instance: 'lab' })), 'local.scrum-harness.lab.alerts')
  })

  it('escapes what XML reads specially in a path', () => {
    const plist = plistOf(JOB, setupIn({ scrumDir: '/opt/a&b<c>' }))
    assert.match(plist, /<string>\/opt\/a&amp;b&lt;c&gt;\/bin\/scrum<\/string>/)
  })

  it('passes the plutil check (macOS only)', { skip: process.platform !== 'darwin' }, () => {
    const file = join(mkdtempSync(join(tmpdir(), 'scrum-plist-')), 'test.plist')
    writeFileSync(file, plistOf(JOB, setupIn()))
    const result = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  })
})

describe('installing under launchd', () => {
  it('writes the file, loads it into the user domain, and runs it once', () => {
    const setup = setupIn()
    const { run, calls } = recordingRun()
    const message = launchdScheduler(run, 501).install(JOB, setup)
    const path = join(setup.home, 'Library', 'LaunchAgents', 'local.scrum-harness.alerts.plist')
    assert.equal(readFileSync(path, 'utf8'), plistOf(JOB, setup))
    assert.deepEqual(calls, [['launchctl', 'bootstrap', 'gui/501', path], ['launchctl', 'kickstart', '-k', 'gui/501/local.scrum-harness.alerts']])
    assert.match(message, /alerts-launchd\.log/)
  })

  it('stops with launchctl\'s own message when loading fails', () => {
    const { run } = recordingRun(['bootstrap'])
    assert.throws(() => launchdScheduler(run, 501).install(JOB, setupIn()), /launchctl bootstrap .* failed: failed on purpose/)
  })

  it('unloads the job and removes the file, also when launchd did not know it', () => {
    const setup = setupIn()
    launchdScheduler(recordingRun().run, 501).install(JOB, setup)
    const path = join(setup.home, 'Library', 'LaunchAgents', 'local.scrum-harness.alerts.plist')
    const { run, calls } = recordingRun(['bootout'])
    const message = launchdScheduler(run, 501).uninstall(JOB, setup)
    assert.deepEqual(calls, [['launchctl', 'bootout', 'gui/501/local.scrum-harness.alerts']])
    assert.equal(existsSync(path), false)
    assert.match(message, /did not know/)
  })

  it('reports only the state and the last exit code', () => {
    const printed = '{\n\tstate = not running\n\tprogram = /x\n\tlast exit code = 0\n}'
    const { run } = recordingRun([], { print: printed })
    assert.equal(launchdScheduler(run, 501).status(JOB, setupIn()), 'state = not running\nlast exit code = 0')
    assert.match(launchdScheduler(recordingRun(['print']).run, 501).status(JOB, setupIn()), /is not installed/)
  })
})
