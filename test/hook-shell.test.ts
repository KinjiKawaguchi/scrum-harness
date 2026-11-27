import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/scrum', import.meta.url))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The hook entry point with a `node` that only records that it was started, so that what the shell layer decides without node can be seen. */
function setup(patterns: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'scrum-hook-shell-'))
  const state = join(dir, 'state')
  const state0 = state
  mkdirSync(join(state, 'cache'), { recursive: true })
  mkdirSync(join(state, 'log'), { recursive: true })
  if (patterns !== null) writeFileSync(join(state, 'cache', 'shell-patterns'), patterns)
  const fakeBin = join(dir, 'bin')
  mkdirSync(fakeBin)
  const started = join(dir, 'started.log')
  writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\nprintf '%s\\n' "$*" >>${started}\ncat >/dev/null\n`)
  chmodSync(join(fakeBin, 'node'), 0o755)
  const run = async (event: string, name: string | null, payload: object = {}): Promise<readonly string[]> => {
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, SCRUM_STATE_DIR: state, SCRUM_NAME: name ?? '' }
    spawnSync(BIN, ['hook', event], { input: JSON.stringify({ session_id: 'sid-1', ...payload }), env, encoding: 'utf8' })
    // a node started in the background logs when the machine lets it; nothing started is told by waiting this long
    let lines: string[] = []
    for (let waited = 0; waited < 3000 && lines.length === 0; waited += 100) {
      await wait(100)
      lines = existsSync(started) ? readFileSync(started, 'utf8').split('\n').filter((line) => line !== '') : []
    }
    writeFileSync(started, '')
    return lines
  }
  const heartbeat = (state: string): void => {
    mkdirSync(join(state0, 'team'), { recursive: true })
    writeFileSync(join(state0, 'team', 'sid-1.json'), JSON.stringify({ sessionId: 'sid-1', name: 'SWE1', state }, null, 1))
  }
  return { run, heartbeat }
}

const PATTERNS = 'gh pr merge|set-status\nset-status\n0\n0\nLead\nSWE1|SWE 2\n'
const tool = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '' } })

describe('what bin/scrum does for a session that has SCRUM_NAME, without starting node', () => {
  it('starts no node for a member\'s tool call', async () => {
    const { run } = setup(PATTERNS)
    assert.deepEqual(await run('PostToolUse', 'SWE1', tool('ls')), [])
    assert.deepEqual(await run('PostToolUse', 'SWE 2', tool('ls')), [])
  })

  it('starts node for a member\'s tool call that opens a pull request, since the hook records who opened it', async () => {
    const { run } = setup(PATTERNS)
    assert.equal((await run('PostToolUse', 'SWE1', tool('gh pr create --fill'))).length, 1)
  })

  it('starts node for a tool call after a permission prompt, to correct the heartbeat that says the session waits, and for nothing else', async () => {
    const { run, heartbeat } = setup(PATTERNS)
    heartbeat('busy')
    assert.deepEqual(await run('PostToolUse', 'SWE1', tool('ls')), [])
    heartbeat('waiting')
    assert.equal((await run('PostToolUse', 'SWE1', tool('ls'))).length, 1)
    assert.equal((await run('PostToolUse', 'Lead', tool('ls'))).length, 1)
  })

  it('starts node in the background for a member\'s turn boundaries, so that the heartbeat is still written', async () => {
    const { run } = setup(PATTERNS)
    for (const event of ['UserPromptSubmit', 'Stop', 'SessionStart']) assert.equal((await run(event, 'SWE1')).length, 1, event)
  })

  it('starts node for the TechLead\'s tool call only after a board command, and for its turn boundaries always', async () => {
    const { run } = setup(PATTERNS)
    assert.deepEqual(await run('PostToolUse', 'Lead', tool('ls')), [])
    assert.equal((await run('PostToolUse', 'Lead', tool('gh pr merge 5'))).length, 1)
    assert.equal((await run('Stop', 'Lead')).length, 1)
  })

  it('leaves a name that is not in the list, and a file written without the names, to node', async () => {
    const { run } = setup(PATTERNS)
    assert.equal((await run('PostToolUse', 'Someone', tool('ls'))).length, 1)
    const old = setup('gh pr merge|set-status\nset-status\n0\n0\n')
    assert.equal((await old.run('PostToolUse', 'SWE1', tool('ls'))).length, 1)
    const none = setup(null)
    assert.equal((await none.run('PostToolUse', 'SWE1', tool('ls'))).length, 1)
  })
})
