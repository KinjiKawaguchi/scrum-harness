import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/scrum', import.meta.url))

/** Puts a fake that only records being called at the front of PATH in place of node, to check how bin/scrum dispatches. */
function run(role: string, patterns: string, args: readonly string[]): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'scrum-bin-'))
  const calls = join(dir, 'calls')
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'node'), `#!/bin/sh\necho called >> "${calls}"\n`)
  chmodSync(join(dir, 'bin', 'node'), 0o755)
  mkdirSync(join(dir, 'state', 'identity'), { recursive: true })
  mkdirSync(join(dir, 'state', 'cache'))
  writeFileSync(join(dir, 'state', 'identity', 'abc.json'), `{\n "name": "x",\n "role": "${role}"\n}\n`)
  writeFileSync(join(dir, 'state', 'cache', 'shell-patterns'), patterns)
  const env = { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, SCRUM_STATE_DIR: join(dir, 'state'), HOME: dir }
  const result = spawnSync('/bin/sh', [BIN, ...args], { input: '{"session_id":"abc"}', env, encoding: 'utf8' })
  assert.equal(result.status, 0)
  return existsSync(calls) && readFileSync(calls, 'utf8').includes('called')
}

const patterns = (dispatch: string, alerts: string) => `post\npre\n${dispatch}\n${alerts}\n`

describe('bin/scrum liaison dispatch', () => {
  it('the liaison starts node in a watch only when line 4 is 1', () => {
    assert.equal(run('liaison', patterns('0', '1'), ['watch']), true)
    assert.equal(run('liaison', patterns('1', '0'), ['watch']), false)
    assert.equal(run('liaison', 'post\npre\n', ['watch']), false)
  })

  it('the liaison does not start node for hooks other than watch (Stop, PostToolUse, SessionStart)', () => {
    for (const event of ['Stop', 'PostToolUse', 'SessionStart', 'UserPromptSubmit']) {
      assert.equal(run('liaison', patterns('1', '1'), ['hook', event]), false, event)
    }
  })

  it('a member starts node in a watch only when line 3 is 1; the TechLead always does; a session outside the team does not', () => {
    assert.equal(run('member', patterns('1', '0'), ['watch']), true)
    assert.equal(run('member', patterns('0', '1'), ['watch']), false)
    assert.equal(run('techlead', patterns('0', '0'), ['watch']), true)
    assert.equal(run('none', patterns('1', '1'), ['watch']), false)
  })
})

/** Creates a home directory holding the fake node, so bin/scrum can be called any number of times. Returns the lines appended to events.jsonl. */
function hookSandbox(role: string, options: { readonly withLogDir?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scrum-bin-act-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'node'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'bin', 'node'), 0o755)
  mkdirSync(join(dir, 'state', 'identity'), { recursive: true })
  mkdirSync(join(dir, 'state', 'cache'))
  if (options.withLogDir !== false) mkdirSync(join(dir, 'state', 'log'))
  if (role !== '') writeFileSync(join(dir, 'state', 'identity', 'abc.json'), `{\n "name": "x",\n "role": "${role}"\n}\n`)
  writeFileSync(join(dir, 'state', 'cache', 'shell-patterns'), patterns('0', '0'))
  const env = { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, SCRUM_STATE_DIR: join(dir, 'state'), HOME: dir }
  const events = join(dir, 'state', 'log', 'events.jsonl')
  const due = join(dir, 'state', 'cache', 'activity-due')
  return {
    due,
    call(args: readonly string[]): void {
      const result = spawnSync('/bin/sh', [BIN, ...args], { input: '{"session_id":"abc"}', env, encoding: 'utf8' })
      assert.equal(result.status, 0)
    },
    lines: (): readonly Record<string, string>[] =>
      existsSync(events) ? readFileSync(events, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, string>) : [],
  }
}

describe('bin/scrum activity record (activity)', () => {
  it('in any session of the TechLead, a member, or the liaison, PostToolUse appends one line to the activity record (keeping the role)', () => {
    for (const role of ['techlead', 'member', 'liaison']) {
      const sandbox = hookSandbox(role)
      sandbox.call(['hook', 'PostToolUse'])
      const lines = sandbox.lines()
      assert.equal(lines.length, 1, role)
      assert.equal(lines[0]?.type, 'activity', role)
      assert.equal(lines[0]?.role, role)
      assert.match(lines[0]?.at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/, role)
    }
  })

  it('does not append for a session whose role is undecided (no identity copy), since it may be outside the team', () => {
    const sandbox = hookSandbox('')
    sandbox.call(['hook', 'PostToolUse'])
    assert.equal(sandbox.lines().length, 0)
  })

  it('does not append for UserPromptSubmit, SessionStart, or Stop (these hooks also pass during the weekly limit, on the input of a scheduled run)', () => {
    for (const event of ['UserPromptSubmit', 'SessionStart', 'Stop']) {
      for (const role of ['member', 'techlead', 'liaison']) {
        const sandbox = hookSandbox(role)
        sandbox.call(['hook', event])
        assert.equal(sandbox.lines().length, 0, `${role} ${event}`)
      }
    }
  })

  it('does not append for sessions outside the team, or for PreToolUse, Notification, SessionEnd, and statusline', () => {
    const outside = hookSandbox('none')
    outside.call(['hook', 'PostToolUse'])
    assert.equal(outside.lines().length, 0)
    for (const args of [['hook', 'PreToolUse'], ['hook', 'Notification'], ['hook', 'SessionEnd'], ['statusline']]) {
      const sandbox = hookSandbox('techlead')
      sandbox.call(args)
      assert.equal(sandbox.lines().length, 0, args.join(' '))
    }
  })

  it('after appending, does not append for the next 10 minutes; appends once the next write time (activity-due) has passed', () => {
    const sandbox = hookSandbox('member')
    sandbox.call(['hook', 'PostToolUse'])
    sandbox.call(['hook', 'PostToolUse'])
    assert.equal(sandbox.lines().length, 1)
    // The next time to write is 10 minutes after the time that was appended (it falls between 9 and 11 minutes)
    const untilDue = statSync(sandbox.due).mtimeMs - Date.now()
    assert.ok(untilDue > 9 * 60_000 && untilDue <= 10 * 60_000 + 2000, `${untilDue} ms until the next write`)
    const inOneMinute = new Date(Date.now() + 60_000)
    utimesSync(sandbox.due, inOneMinute, inOneMinute)
    sandbox.call(['hook', 'PostToolUse'])
    assert.equal(sandbox.lines().length, 1)
    const oneMinuteAgo = new Date(Date.now() - 60_000)
    utimesSync(sandbox.due, oneMinuteAgo, oneMinuteAgo)
    sandbox.call(['hook', 'PostToolUse'])
    assert.equal(sandbox.lines().length, 2)
  })

  it('when the log directory is missing, appends nothing and the hook exits with 0', () => {
    const sandbox = hookSandbox('member', { withLogDir: false })
    sandbox.call(['hook', 'PostToolUse'])
    assert.equal(sandbox.lines().length, 0)
    assert.equal(existsSync(sandbox.due), false)
  })
})
