import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmuxHost } from '../src/adapters/tmux/host.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const BIN = fileURLToPath(new URL('../bin/scrum', import.meta.url))
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.sh', import.meta.url))
const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The path a member takes through tmux, with a stand-in for `claude` (test/fixtures/fake-claude.sh) in a window of a private tmux server: start (the question
 * about the folder is answered, by the keys the harness sends, in a window of the default 80 columns), a line typed into it, and a stop that waits for the
 * session's end. It runs the same on Linux and macOS: it is what moving a team to another machine depends on.
 */
describe('a member in a real tmux window', { skip: !hasTmux }, () => {
  // a short path: the window the harness reads is only so wide (and the question names the folder)
  const dir = mkdtempSync(join('/tmp', 'st-'))
  const state = join(dir, 'state')
  const work = join(dir, 'swe1')
  const fakeBin = join(dir, 'bin')
  const tmuxDir = join(dir, 'tmux')
  const session = `scrum-test-${process.pid}`
  mkdirSync(work)
  mkdirSync(fakeBin)
  mkdirSync(tmuxDir)
  // the host the test uses (to type a line) finds the private server the same way the harness does
  process.env.TMUX_TMPDIR = tmuxDir
  delete process.env.TMUX
  process.env.TERM = 'xterm'
  copyFileSync(FAKE_CLAUDE, join(fakeBin, 'claude'))
  chmodSync(join(fakeBin, 'claude'), 0o755)
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, SCRUM_STATE_DIR: state, SCRUM_NAME: '', TMUX_TMPDIR: tmuxDir, TERM: 'xterm', TMUX: '' }
  const scrum = (...args: string[]) => spawnSync('node', ['--no-warnings', CLI, ...args], { env, encoding: 'utf8' })

  const init = scrum('init', '--state-dir', state, '--project-id', 'PVT_xxxxxxxxxxxxxxxxxxxx', '--status-field-id', 'PVTSSF_xxxxxxxxxxxxxxxxxxxx', '--repos', 'acme/app', '--owner-user', '@owner', '--techlead', 'TechLead', '--members', 'SWE1')
  const configPath = join(state, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  writeFileSync(configPath, JSON.stringify({ ...config, launch: { tmuxSession: session, members: { SWE1: { dir: work, trustDirectory: true, startupSeconds: 40, startupRetries: 0 } } } }))
  writeFileSync(join(state, 'fake-claude-hook'), BIN)

  after(() => {
    spawnSync('tmux', ['kill-server'], { env, encoding: 'utf8' })
  })

  it('is set up', () => {
    assert.equal(init.status, 0, init.stderr)
  })

  it('starts, answers the question about the folder, and waits for the sign of life', () => {
    const started = scrum('member', 'start', 'SWE1')
    assert.match(started.stdout, /SWE1: started in .*shows a sign of life/, started.stdout + started.stderr)
    const screen = spawnSync('tmux', ['capture-pane', '-p', '-t', `=${session}:SWE1`], { env, encoding: 'utf8' }).stdout
    assert.match(screen, /Welcome to the fake Claude Code/)
    assert.match(scrum('member', 'list').stdout, /SWE1\s+member\s+running/)
  })

  it('types a line into the window, as a person does', () => {
    tmuxHost().say(session, 'SWE1', 'continue with the next item')
    const log = join(state, 'fake-claude.log')
    for (let tries = 0; tries < 30 && !existsSync(log); tries += 1) spawnSync('sleep', ['0.2'])
    assert.equal(readFileSync(log, 'utf8').trim(), 'continue with the next item')
  })

  it('stops it by asking it to exit, and sees the session end', async () => {
    const stopped = scrum('member', 'stop', 'SWE1')
    assert.match(stopped.stdout, /SWE1: exited/, stopped.stdout + stopped.stderr)
    await wait(200)
    assert.equal(tmuxHost().windows(session)?.includes('SWE1') ?? false, false)
  })
})
