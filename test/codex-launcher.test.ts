import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { codexLauncher } from '../src/adapters/codex/launch.ts'
import { memberCommand } from '../src/members/command.ts'
import { parseLaunch, type MemberSpec } from '../src/members/config.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeLauncher } from '../src/adapters/claude-code/launch.ts'
import type { Config } from '../src/config.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base } from './helpers.ts'

const SCRUM = '/opt/scrum-harness/bin/scrum'
const argvOf = (spec: MemberSpec, brief = 'Do the work', scrum = SCRUM) => codexLauncher({ name: 'CodexA', spec, brief }, scrum)

/** The `-c` values of an argv, as [key, value] in order. */
const settingsOf = (argv: readonly string[]): readonly (readonly [string, string])[] =>
  argv.flatMap((word, index) => (word === '-c' ? [[(argv[index + 1] ?? '').split('=')[0] ?? '', (argv[index + 1] ?? '').slice((argv[index + 1] ?? '').indexOf('=') + 1)] as const] : []))

describe('the Codex launcher', () => {
  it('starts codex with the brief last, the hooks trusted for the session, and the model and effort given', () => {
    const argv = argvOf({ model: 'gpt-x', effort: 'high' })
    assert.equal(argv[0], 'codex')
    assert.equal(argv.at(-1), 'Do the work')
    assert.deepEqual([argv.includes('--dangerously-bypass-hook-trust'), argv.slice(argv.indexOf('-m'), argv.indexOf('-m') + 2)], [true, ['-m', 'gpt-x']])
    assert.deepEqual(settingsOf(argv).find(([key]) => key === 'model_reasoning_effort'), ['model_reasoning_effort', '"high"'])
  })

  it('passes each hook of the harness by -c, with the same events and limits as a Claude Code member, and no file written', () => {
    const hooks = settingsOf(argvOf({})).filter(([key]) => key.startsWith('hooks.'))
    assert.deepEqual(hooks.map(([key]) => key), ['hooks.SessionStart', 'hooks.UserPromptSubmit', 'hooks.PreToolUse', 'hooks.PostToolUse', 'hooks.Stop', 'hooks.SessionEnd'])
    const stop = hooks.find(([key]) => key === 'hooks.Stop')?.[1] ?? ''
    assert.match(stop, /^\[\{hooks=\[\{type="command",command=".*",timeoutSec=15\}\]\}\]$/)
    assert.equal(JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(stop)?.[1] ?? '""'), `${SCRUM} hook Stop`)
  })

  it('quotes a path with a space or a quote for the shell, and escapes it for TOML', () => {
    const hooks = settingsOf(argvOf({}, 'x', "/opt/my tools/it's/scrum")).filter(([key]) => key === 'hooks.PreToolUse')
    const command = JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(hooks[0]?.[1] ?? '')?.[1] ?? '""') as string
    assert.equal(command, "'/opt/my tools/it'\\''s/scrum' hook PreToolUse")
  })

  it('points at the harness\'s own bin/scrum by default', () => {
    const command = JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(settingsOf(codexLauncher({ name: 'A', spec: {}, brief: '' })).find(([key]) => key === 'hooks.Stop')?.[1] ?? '')?.[1] ?? '""') as string
    const path = command.replace(/ hook Stop$/, '')
    assert.equal(existsSync(path), true, path)
  })

  it('leaves approvals and the sandbox to the user\'s Codex configuration, unless told', () => {
    const plain = argvOf({})
    assert.deepEqual([plain.includes('-s'), plain.includes('--dangerously-bypass-approvals-and-sandbox')], [false, false])
    const sandboxed = argvOf({ sandbox: 'read-only' })
    assert.deepEqual(sandboxed.slice(1, 3), ['-s', 'read-only'])
  })

  it('bypasses approvals and the sandbox only for a member that says permissions skip, and then does not also set a sandbox', () => {
    const argv = argvOf({ permissions: 'skip', sandbox: 'read-only' })
    assert.equal(argv[1], '--dangerously-bypass-approvals-and-sandbox')
    assert.equal(argv.includes('-s'), false)
  })

  it('has no session name flag (the member is known by SCRUM_NAME), and no brief when there is none', () => {
    assert.equal(argvOf({}).includes('-n'), false)
    assert.equal(argvOf({}, '').at(-1)?.startsWith('hooks.'), true)
  })
})

describe('a Codex member in the launch section', () => {
  it('reads product codex and a sandbox, and refuses a sandbox that is not one', () => {
    assert.equal(parseLaunch({ tmuxSession: 't', members: { A: { product: 'codex', sandbox: 'workspace-write' } } })?.members.A?.product, 'codex')
    assert.equal(parseLaunch({ tmuxSession: 't', members: { A: { sandbox: 'everything' } } }), undefined)
  })

  it('is started by the launcher of its product, with the same environment as any member', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-codex-member-'))
    const brief = join(dir, 'brief.txt')
    writeFileSync(brief, 'You are CodexA.\n')
    const config: Config = { ...base, members: ['CodexA', 'ClaudeB'], launch: parseLaunch({ tmuxSession: 'team', members: { CodexA: { dir, brief, product: 'codex', model: 'gpt-x' }, ClaudeB: { dir, brief } } }) }
    const ports = fakePorts({ members: { windows: () => ['home'], start: () => undefined, stop: () => undefined, screen: () => null, press: () => undefined }, launchers: { 'claude-code': claudeCodeLauncher, codex: codexLauncher } })
    const text = memberCommand(config, ports, ['start', 'CodexA', 'ClaudeB'], { 'dry-run': true })
    assert.match(text, /CodexA: in .*\n  env SCRUM_STATE_DIR=\S+ SCRUM_NAME=CodexA PATH=<this process's PATH> codex --dangerously-bypass-hook-trust -m gpt-x -c 'hooks\.SessionStart=.*<brief: 15 characters>/)
    assert.match(text, /ClaudeB: in .*\n  env .* claude -n ClaudeB/)
    assert.equal(text.includes('You are CodexA'), false)
  })
})
