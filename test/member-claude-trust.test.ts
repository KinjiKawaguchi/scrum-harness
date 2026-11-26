import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeLauncher } from '../src/adapters/claude-code/launch.ts'
import { codexLauncher } from '../src/adapters/codex/launch.ts'
import type { Config } from '../src/config.ts'
import { memberCommand, type WatchdogDeps } from '../src/members/command.ts'
import { parseLaunch } from '../src/members/config.ts'
import { lintStartFailures } from '../src/members/rules.ts'
import { readStartFailures } from '../src/members/start-failures.ts'
import { claudeTrustKey, screenQuestion } from '../src/members/trust.ts'
import { watchdogOf } from '../src/members/watchdog.ts'
import { paths, type Paths } from '../src/store.ts'
import type { SessionSignal } from '../src/team/types.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, NOW } from './helpers.ts'

/** The screen Claude Code 2.1.332 shows the first time a login runs in a folder, as tmux captures it. "No, exit" is focused when it opens. */
const question = (folder: string, focused: 'No, exit' | 'Yes, I trust this folder', extra = ''): string =>
  [
    ' Accessing workspace:',
    '',
    ` ${folder}`,
    '',
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open",
    " source project, or work from your team). If not, take a moment to review what's in this folder first.",
    '',
    extra,
    " Claude Code'll be able to read, edit, and execute files here.",
    '',
    ' Security guide',
    '',
    focused === 'No, exit' ? ' ❯ No, exit' : '   No, exit',
    focused === 'Yes, I trust this folder' ? ' ❯ Yes, I trust this folder' : '   Yes, I trust this folder',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n')

const signal = (name: string, updatedAt: Date): SessionSignal => ({ sessionId: `s-${name}`, name, state: 'idle', since: updatedAt.toISOString(), updatedAt: updatedAt.toISOString(), isAlive: true, nameSince: null })

function clock(start: Date = NOW) {
  let at = start.getTime()
  return { now: () => new Date(at), sleep: (milliseconds: number) => void (at += milliseconds) }
}

describe('which key Claude Code\'s question about a folder gets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrum-claude-trust-'))

  it('is Down while "No, exit" is focused, and Enter once "Yes, I trust this folder" is', () => {
    assert.equal(claudeTrustKey(question(dir, 'No, exit'), dir), 'Down')
    assert.equal(claudeTrustKey(question(dir, 'Yes, I trust this folder'), dir), 'Enter')
  })

  it('reads the folder as the system names it (the screen shows /private/tmp for /tmp), and a long path that the window wrapped', () => {
    assert.equal(claudeTrustKey(question(realpathSync(dir), 'No, exit'), dir), 'Down')
    const half = Math.floor(dir.length / 2)
    assert.equal(claudeTrustKey(question(`${dir.slice(0, half)}\n ${dir.slice(half)}`, 'No, exit'), dir), 'Down')
  })

  it('is null for a folder that is not the member\'s, for the longer form that brings settings that run code, and for any other screen', () => {
    assert.equal(claudeTrustKey(question('/somewhere/else', 'No, exit'), dir), null)
    assert.equal(claudeTrustKey(question(`${dir}/sub`, 'No, exit'), dir), null)
    assert.equal(claudeTrustKey(question(dir, 'No, exit', ' This folder configures hooks that can run commands without asking, declared in .claude/settings.json'), dir), null)
    assert.equal(claudeTrustKey(question(dir, 'No, exit', ' This folder configures MCP servers: db'), dir), null)
    assert.equal(claudeTrustKey('Do you trust the contents of this directory?\n› 1. Yes, continue', dir), null)
    assert.equal(claudeTrustKey(null, dir), null)
    assert.equal(claudeTrustKey(question(dir, 'No, exit').replace('❯', ' '), dir), null)
  })

  it('names the question a window waits at, for the failure message', () => {
    assert.match(screenQuestion(question(dir, 'No, exit')) ?? '', /Claude Code's question whether to trust the folder/)
    assert.match(screenQuestion('Do you trust the contents of this directory?') ?? '', /Codex's question/)
    assert.equal(screenQuestion('Try "create a util logging.py that..."'), null)
  })
})

describe('starting a Claude Code member at the question about its folder', () => {
  let p: Paths
  let dir: string
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-claude-trust-state-')))
    mkdirSync(join(p.dir, 'cache'), { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'scrum-claude-trust-dir-'))
  })

  const config = (spec: Record<string, unknown>): Config => ({ ...base, members: ['ClaudeA'], launch: parseLaunch({ tmuxSession: 'team', members: { ClaudeA: { dir, startupSeconds: 20, startupRetries: 0, ...spec } } }) })

  /** A window that shows the question with "No, exit" focused, moves the focus on Down and takes Enter at "Yes" (ignoring the first `ignored` keys, as the question does just after it opens), and then the member shows a sign of life. */
  function run(spec: Record<string, unknown>, shown: string = dir, ignored = 0) {
    const presses: string[] = []
    let focused: 'No, exit' | 'Yes, I trust this folder' = 'No, exit'
    let isAnswered = false
    const time = clock()
    const press = (_session: string, _name: string, key: string): void => {
      presses.push(key)
      if (presses.length <= ignored) return
      if (key === 'Down') focused = 'Yes, I trust this folder'
      if (key === 'Enter' && focused === 'Yes, I trust this folder') isAnswered = true
    }
    const ports = fakePorts({ members: { windows: () => ['home'], start: () => undefined, stop: () => undefined, screen: () => (isAnswered ? 'Try "create a util logging.py that..."' : question(shown, focused)), press }, launchers: { 'claude-code': claudeCodeLauncher, codex: codexLauncher } })
    const deps: WatchdogDeps = { startFailuresPath: p.startFailures, now: time.now, sleep: time.sleep, signals: () => (isAnswered ? [signal('ClaudeA', time.now())] : []) }
    return { text: memberCommand(config(spec), ports, ['start', 'ClaudeA'], {}, deps), presses }
  }

  it('answers Down and then Enter for a member that is set to have it answered', () => {
    const { text, presses } = run({ trustDirectory: true })
    assert.deepEqual(presses, ['Down', 'Enter'])
    assert.match(text, /shows a sign of life/)
  })

  it('sends a key again when the question did not take it, and gives up after a few', () => {
    assert.deepEqual(run({ trustDirectory: true }, dir, 1).presses, ['Down', 'Down', 'Enter'])
    const stuck = run({ trustDirectory: true }, dir, 99)
    assert.equal(stuck.presses.length, 6)
    assert.match(stuck.text, /no sign of life/)
  })

  it('leaves the question alone without trustDirectory, for another folder, and says what the window waited at', () => {
    const left = run({})
    assert.deepEqual(left.presses, [])
    assert.match(left.text, /no sign of life.*Its window showed: .*Enter to confirm.*It is waiting at Claude Code's question whether to trust the folder/)
    const other = run({ trustDirectory: true }, '/somewhere/else')
    assert.deepEqual(other.presses, [])
    assert.match(other.text, /waiting at Claude Code's question/)
  })

  it('keeps the question in the finding, as what the window showed', () => {
    run({})
    const [failure] = readStartFailures(p.startFailures)
    assert.match(failure?.screen ?? '', /Yes, I trust this folder/)
    const [finding] = lintStartFailures(readStartFailures(p.startFailures), [{ name: 'ClaudeA', state: 'unknown', since: null }])
    assert.match(finding?.message ?? '', /Its window showed: .*Yes, I trust this folder/)
  })

  it('watches a member that is to have it answered even when no startupSeconds is set', () => {
    assert.deepEqual(watchdogOf({ trustDirectory: true }), { seconds: 60, retries: 2 })
    assert.equal(watchdogOf({}), null)
  })
})
