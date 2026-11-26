import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { alertsOf } from '../src/alerts/config.ts'
import { parseConfig } from '../src/config.ts'
import { configFromFlags, initCommand, STATE_FOLDERS, type InitFlags } from '../src/init/command.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const FLAGS: InitFlags = { 'project-id': 'PVT_abc123', 'status-field-id': 'PVTSSF_abc123', repos: 'acme/app,acme/mobile', 'owner-user': '@alice' }
const dir = () => mkdtempSync(join(tmpdir(), 'scrum-init-'))
const problemsOf = (flags: InitFlags) => ('problems' in configFromFlags(flags) ? (configFromFlags(flags) as { problems: readonly string[] }).problems : [])

describe('the configuration scrum init builds', () => {
  it('is a configuration the harness accepts, with the first repository as the default', () => {
    const built = configFromFlags(FLAGS)
    assert.ok('config' in built)
    const config = parseConfig(built.config)
    assert.deepEqual([config?.repos, config?.defaultRepo, config?.ownerUser, config?.techlead, config?.members], [['acme/app', 'acme/mobile'], 'acme/app', '@alice', 'TechLead', ['SWE1', 'SWE2']])
  })

  it('takes the names, the default repository, the owner label, and the excluded authors from flags', () => {
    const built = configFromFlags({ ...FLAGS, techlead: 'Lead', members: 'A, B ,C', 'default-repo': 'acme/mobile', 'owner-label': 'Alice', 'exclude-authors': 'bot1,bot2' })
    assert.ok('config' in built)
    const config = parseConfig(built.config)
    assert.deepEqual([config?.techlead, config?.members, config?.defaultRepo, config?.ownerLabel, config?.excludeAuthors], ['Lead', ['A', 'B', 'C'], 'acme/mobile', 'Alice', ['bot1', 'bot2']])
  })

  it('turns the stall detection on only when a liaison is named', () => {
    const without = parseConfig((configFromFlags(FLAGS) as { config: Record<string, unknown> }).config)
    const withLiaison = parseConfig((configFromFlags({ ...FLAGS, liaison: 'Liaison' }) as { config: Record<string, unknown> }).config)
    assert.deepEqual([alertsOf(without as never).enabled, alertsOf(withLiaison as never).enabled, alertsOf(withLiaison as never).liaison], [false, true, 'Liaison'])
  })

  it('writes a team section when the board is shared, with the field named Team unless told otherwise', () => {
    const configOf = (flags: InitFlags) => parseConfig((configFromFlags({ ...FLAGS, ...flags }) as { config: Record<string, unknown> }).config)
    assert.deepEqual(configOf({ team: 'node' })?.team, { field: 'Team', value: 'node', adoptsUnassigned: false })
    assert.deepEqual(configOf({ team: ' clients ', 'team-field': 'Squad', 'adopts-unassigned': true })?.team, { field: 'Squad', value: 'clients', adoptsUnassigned: true })
    assert.equal(configOf({})?.team, undefined)
  })

  it('writes the work type field and the GitHub host when they are given', () => {
    const config = parseConfig((configFromFlags({ ...FLAGS, 'work-type-field': 'Work type', host: 'ghe.example.com' }) as { config: Record<string, unknown> }).config)
    assert.deepEqual([config?.fields.workType, config?.host], ['Work type', 'ghe.example.com'])
  })

  const refused: readonly (readonly [string, InitFlags, RegExp])[] = [
    ['no flags', {}, /--project-id/],
    ['a team that is empty', { ...FLAGS, team: ' ' }, /--team needs/],
    ['a team field without a team', { ...FLAGS, 'team-field': 'Squad' }, /need --team/],
    ['adopting unassigned work without a team', { ...FLAGS, 'adopts-unassigned': true }, /need --team/],
    ['a host that is not a host name', { ...FLAGS, host: 'https://ghe.example.com' }, /--host/],
    ['a project id that is not a node id', { ...FLAGS, 'project-id': 'abc' }, /--project-id/],
    ['a status field id that is not a node id', { ...FLAGS, 'status-field-id': 'PVT_x' }, /--status-field-id/],
    ['a repository without an owner', { ...FLAGS, repos: 'app' }, /--repos/],
    ['a default repository outside the list', { ...FLAGS, 'default-repo': 'acme/other' }, /--default-repo/],
    ['an owner login without @', { ...FLAGS, 'owner-user': 'alice' }, /--owner-user/],
    ['a flag with no value', { ...FLAGS, repos: true }, /--repos/],
    ['a session name with a slash', { ...FLAGS, techlead: 'a/b' }, /session names/],
    ['two sessions with one name', { ...FLAGS, techlead: 'SWE1' }, /different names/],
  ]
  for (const [name, flags, pattern] of refused) {
    it(`refuses ${name}`, () => {
      assert.match(problemsOf(flags).join('\n'), pattern)
    })
  }
})

describe('scrum init writing the state directory', () => {
  it('creates the folders and the configuration, and says what to do next', () => {
    const state = join(dir(), 'team')
    const result = initCommand(state, false, '~/scrum/bin/scrum', FLAGS)
    assert.equal(result.ok, true)
    assert.deepEqual(readdirSync(state).toSorted(), ['config.json', ...STATE_FOLDERS].toSorted())
    assert.equal(parseConfig(JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')))?.projectId, 'PVT_abc123')
    assert.match(result.text, new RegExp(`export SCRUM_STATE_DIR=${state}`))
    assert.match(result.text, /~\/scrum\/bin\/scrum schedule install --name <team>/)
  })

  it('does not tell the user to export the state directory when it is the default', () => {
    const result = initCommand(join(dir(), 'scrum'), true, 'scrum', FLAGS)
    assert.doesNotMatch(result.text, /SCRUM_STATE_DIR/)
  })

  it('does not overwrite a configuration unless forced', () => {
    const state = dir()
    writeFileSync(join(state, 'config.json'), '{"keep":true}')
    const refused = initCommand(state, false, 'scrum', FLAGS)
    assert.deepEqual([refused.ok, readFileSync(join(state, 'config.json'), 'utf8')], [false, '{"keep":true}'])
    assert.match(refused.text, /--force/)
    assert.equal(initCommand(state, false, 'scrum', { ...FLAGS, force: true }).ok, true)
    assert.equal(parseConfig(JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')))?.defaultRepo, 'acme/app')
  })

  it('writes nothing when the flags are wrong', () => {
    const state = join(dir(), 'never')
    const result = initCommand(state, false, 'scrum', { ...FLAGS, repos: 'app' })
    assert.deepEqual([result.ok, existsSync(state)], [false, false])
    assert.match(result.text, /Usage: scrum init/)
  })
})

describe('scrum init and scrum schedule on the command line', () => {
  function scrum(args: string[], env: Record<string, string>) {
    const run = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } })
    return { status: run.status, stdout: run.stdout, stderr: run.stderr }
  }

  it('init writes the team and a SCRUM_STATE_DIR-less run reads it back with lint', () => {
    const state = join(dir(), 'team')
    const init = scrum(['init', '--project-id', 'PVT_abc', '--status-field-id', 'PVTSSF_abc', '--repos', 'acme/app', '--owner-user', '@alice', '--state-dir', state], { HOME: dir() })
    assert.equal(init.status, 0, init.stderr)
    assert.equal(statSync(join(state, 'config.json')).isFile(), true)
    const again = scrum(['init', '--project-id', 'PVT_abc', '--status-field-id', 'PVTSSF_abc', '--repos', 'acme/app', '--owner-user', '@alice', '--state-dir', state], { HOME: dir() })
    assert.deepEqual([again.status, /--force/.test(again.stdout)], [1, true])
  })

  it('init exits 1 with the usage when flags are missing', () => {
    const result = scrum(['init'], { HOME: dir() })
    assert.deepEqual([result.status, /Usage: scrum init/.test(result.stdout)], [1, true])
  })

  it('schedule print shows the units of this platform, with gh and node in the PATH, and writes nothing', { skip: process.platform !== 'linux' && process.platform !== 'darwin' }, () => {
    const home = dir()
    const bin = join(dir(), 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\n')
    chmodSync(join(bin, 'gh'), 0o755)
    const result = scrum(['schedule', 'print', '--name', 'lab'], { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SCRUM_STATE_DIR: join(home, 'team') })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, process.platform === 'linux' ? /scrum-harness-lab-alerts\.timer/ : /local\.scrum-harness\.lab\.alerts/)
    assert.match(result.stdout, new RegExp(`${bin}`))
    assert.match(result.stdout, /SCRUM_STATE_DIR/)
    assert.deepEqual(readdirSync(home), [])
  })

  it('schedule install stops before writing anything when gh is not found', () => {
    const home = dir()
    const result = scrum(['schedule', 'install'], { HOME: home, PATH: '/nonexistent' })
    assert.deepEqual([result.status, /gh was not found/.test(result.stdout), readdirSync(home)], [1, true, []])
  })
})
