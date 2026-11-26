import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeConfigDirs, isConfigDirPath, projectsDirs, sessionsDirs, settingsPaths } from '../src/adapters/claude-code/config-dirs.ts'
import { claudeCodeSessions } from '../src/adapters/claude-code/sessions.ts'
import { claudeCodeTranscripts } from '../src/adapters/claude-code/transcripts.ts'
import { installCommand, settingsTargets } from '../src/cli-commands.ts'
import { parseConfig } from '../src/config.ts'
import { MARKER } from '../src/install.ts'
import { paths } from '../src/store.ts'
import { config as base } from './helpers.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'scrum-config-dirs-'))
const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'

describe('the Claude Code configuration directories', () => {
  it('is ~/.claude when none is configured, and expands ~/ and drops a repeated directory', () => {
    assert.deepEqual(claudeConfigDirs(undefined), [join(homedir(), '.claude')])
    assert.deepEqual(claudeConfigDirs(['~/.claude-work', '/data/claude', '~/.claude-work']), [join(homedir(), '.claude-work'), '/data/claude'])
  })

  it('derives the session folders, the transcript folders, and the settings files, unless an environment variable names one place', () => {
    const dirs = ['/a', '/b']
    assert.deepEqual([sessionsDirs(dirs, {}), projectsDirs(dirs, {}), settingsPaths(dirs, {})], [['/a/sessions', '/b/sessions'], ['/a/projects', '/b/projects'], ['/a/settings.json', '/b/settings.json']])
    assert.deepEqual([sessionsDirs(dirs, { SCRUM_SESSIONS_DIR: '/s' }), projectsDirs(dirs, { SCRUM_PROJECTS_DIR: '/p' }), settingsPaths(dirs, { SCRUM_SETTINGS: '/x.json' })], [['/s'], ['/p'], ['/x.json']])
  })

  it('accepts only absolute paths, or paths under ~/, in the configuration; a relative one would mean a different place in every process', () => {
    for (const ok of ['/data/claude', '~/.claude-work']) assert.equal(isConfigDirPath(ok), true, ok)
    for (const bad of ['', '.claude', '../x', '~', '~other/x', 7]) assert.equal(isConfigDirPath(bad), false, String(bad))
    assert.deepEqual(parseConfig({ ...base, claudeConfigDirs: ['~/.claude', '/data/claude'] })?.claudeConfigDirs, ['~/.claude', '/data/claude'])
    assert.equal(parseConfig({ ...base, claudeConfigDirs: ['relative/dir'] }), null)
    assert.equal(parseConfig({ ...base, claudeConfigDirs: [] }), null)
    assert.equal(parseConfig(base)?.claudeConfigDirs, undefined)
  })
})

describe('reading what runs under more than one configuration directory', () => {
  function twoDirs() {
    const a = tmp()
    const b = tmp()
    for (const [dir, pid, sessionId, name] of [[a, 10, SESSION_A, 'TechLead'], [b, 20, SESSION_B, 'SWE1']] as const) {
      mkdirSync(join(dir, 'sessions'), { recursive: true })
      writeFileSync(join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, name, status: 'busy', statusUpdatedAt: 1_700_000_000_000 }))
      mkdirSync(join(dir, 'projects', 'proj'), { recursive: true })
      writeFileSync(join(dir, 'projects', 'proj', `${sessionId}.jsonl`), '')
    }
    return [a, b] as const
  }

  it('finds a session by its id and lists the signals of the sessions of every directory', () => {
    const [a, b] = twoDirs()
    const sessions = claudeCodeSessions(sessionsDirs([a, b], {}))
    assert.deepEqual([sessions.find(SESSION_A).name, sessions.find(SESSION_B).name, sessions.find('missing').name], ['TechLead', 'SWE1', null])
    assert.deepEqual(sessions.signals().map((one) => one.name).toSorted(), ['SWE1', 'TechLead'])
  })

  it('lists the transcripts of every directory under their own paths, and the names of all sessions', () => {
    const [a, b] = twoDirs()
    const source = claudeCodeTranscripts(projectsDirs([a, b], {}), sessionsDirs([a, b], {}))
    assert.deepEqual(source.files().map((file) => file.path).toSorted(), [join(a, 'projects', 'proj', `${SESSION_A}.jsonl`), join(b, 'projects', 'proj', `${SESSION_B}.jsonl`)].toSorted())
    assert.deepEqual([...source.names()].toSorted(), [[SESSION_A, 'TechLead'], [SESSION_B, 'SWE1']])
  })

  it('reads a directory that does not exist as empty', () => {
    const sessions = claudeCodeSessions(['/nonexistent/sessions'])
    assert.deepEqual([sessions.signals(), sessions.find(SESSION_A).name], [[], null])
  })
})

describe('scrum install across configuration directories', () => {
  const hasHooks = (path: string): boolean => readFileSync(path, 'utf8').includes(MARKER)

  it('chooses the settings files: one directory, every configured directory, or ~/.claude', () => {
    const config = { ...base, claudeConfigDirs: ['/a', '/b'] }
    assert.deepEqual(settingsTargets({ dir: '/c' }, config), ['/c/settings.json'])
    assert.deepEqual(settingsTargets({ all: true }, config), ['/a/settings.json', '/b/settings.json'])
    assert.deepEqual(settingsTargets({}, config), [join(homedir(), '.claude', 'settings.json')])
    assert.match(settingsTargets({ dir: 'relative' }, config) as string, /--dir must be an absolute path/)
    assert.match(settingsTargets({ all: true }, null) as string, /no configuration/)
  })

  it('adds the hooks to each directory, creating a settings file that is not there yet, and removes them again', () => {
    const [a, b] = [tmp(), tmp()]
    writeFileSync(join(a, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    const p = paths(tmp())
    writeFileSync(join(p.dir, 'config.json'), '{}')
    const targets = [join(a, 'settings.json'), join(b, 'new-dir', 'settings.json')]
    const text = installCommand(p, true, targets)
    assert.deepEqual(targets.map(hasHooks), [true, true])
    assert.equal(JSON.parse(readFileSync(targets[0] as string, 'utf8')).theme, 'dark')
    assert.match(text, /\(backup: .*bak-scrum-harness\)/)
    assert.match(text, /\(a new file\)/)
    assert.equal(existsSync(`${targets[1]}.bak-scrum-harness`), false)
    installCommand(p, false, targets)
    assert.deepEqual(targets.map(hasHooks), [false, false])
  })
})
