import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bashActionReader } from '../src/adapters/github/action-reader.ts'
import { installCommand } from '../src/cli-commands.ts'
import { loadSnapshot, saveSnapshot } from '../src/board/snapshot.ts'
import { parseConfig, type Config } from '../src/config.ts'
import { handleHook, type HookDeps } from '../src/hooks/handlers.ts'
import { withHooks } from '../src/install.ts'
import type { ActionReader, ToolCall } from '../src/ports/index.ts'
import { paths, type Paths } from '../src/store.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, issue, NOW, snapshot } from './helpers.ts'

let p: Paths
const config: Config = { ...base, wipLimit: 1 }

/** What a board module's reader does for one MCP tool: `mcp__tracker__set_status` with `{ key, status }`. */
const mcpReader: ActionReader = {
  actionsOf: (call: ToolCall) => (call.tool === 'mcp__tracker__set_status' && typeof call.input.key === 'string' && typeof call.input.status === 'string' ? [{ kind: 'set-status', label: call.input.key, status: call.input.status }] : []),
  shellPatterns: () => ({ post: 'mcp__tracker__', pre: 'mcp__tracker__set_status' }),
}

function deps(actions: ActionReader): HookDeps {
  return {
    p,
    config,
    now: NOW,
    identity: { sessionId: 'sid', name: 'TechLead', pid: null },
    ports: { actions, code: fakePorts().code, sessions: fakePorts().sessions },
    spawnRefresh: () => undefined,
    spawnCheckpoint: () => undefined,
  }
}

const mcp = (event: string, key: string, status: string, extra: Record<string, unknown> = {}) => ({ session_id: 'sid', hook_event_name: event, tool_name: 'mcp__tracker__set_status', tool_input: { key, status }, ...extra })
const decision = (result: ReturnType<typeof handleHook>) => (result.stdout as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | undefined)?.hookSpecificOutput
const context = (result: ReturnType<typeof handleHook>) => (result.stdout as { hookSpecificOutput?: { additionalContext?: string } } | undefined)?.hookSpecificOutput?.additionalContext ?? ''

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-tool-calls-')))
  saveSnapshot(p, snapshot([issue(1, { status: 'In Progress', assignee: 'SWE1' }), issue(2, { status: 'Backlog' })]))
})

describe('the GitHub reader', () => {
  const reader = bashActionReader(base)

  it('reads a Bash call, and nothing from any other tool', () => {
    assert.deepEqual(reader.actionsOf({ tool: 'Bash', input: { command: './set-status 2 Done' } }), [{ kind: 'set-status', label: 'app#2', status: 'Done' }])
    assert.deepEqual(reader.actionsOf({ tool: 'mcp__tracker__set_status', input: { command: './set-status 2 Done' } }), [])
    assert.deepEqual(reader.actionsOf({ tool: 'Bash', input: { command: 7 } }), [])
    assert.deepEqual(reader.actionsOf({ tool: 'Bash', input: {} }), [])
  })
})

describe('an MCP tool call that writes the board', () => {
  it('is refused before it runs when it would pass the In Progress limit', () => {
    const result = handleHook('PreToolUse', mcp('PreToolUse', 'app#2', 'In Progress'), deps(mcpReader))
    assert.equal(decision(result)?.permissionDecision, 'deny')
    assert.match(decision(result)?.permissionDecisionReason ?? '', /1 items are In Progress, at the limit of 1/)
  })

  it('is let through when it does not break a rule, and when it is not a board write', () => {
    assert.equal(handleHook('PreToolUse', mcp('PreToolUse', 'app#2', 'Next'), deps(mcpReader)).stdout, undefined)
    assert.equal(handleHook('PreToolUse', { session_id: 'sid', tool_name: 'mcp__tracker__search', tool_input: { q: 'x' } }, deps(mcpReader)).stdout, undefined)
  })

  it('has no escape hatch inside its input, as the Bash word SCRUM_GUARD=off is', () => {
    const result = handleHook('PreToolUse', mcp('PreToolUse', 'app#2', 'In Progress', { tool_input: { key: 'app#2', status: 'In Progress', note: 'SCRUM_GUARD=off' } }), deps(mcpReader))
    assert.equal(decision(result)?.permissionDecision, 'deny')
  })

  it('corrects the board copy after it ran, and gives the findings for the item it touched', () => {
    const result = handleHook('PostToolUse', mcp('PostToolUse', 'app#2', 'In Progress', { tool_response: { ok: true } }), deps(mcpReader))
    assert.equal(loadSnapshot(p)?.items.find((item) => item.number === 2)?.status, 'In Progress')
    assert.match(context(result), /findings for the issue you just touched/)
    assert.match(context(result), /B-DOING-NO-ASSIGNEE app#2/)
  })

  it('hands the tool\'s answer to the reader, so a module can confirm what changed', () => {
    const seen: ToolCall[] = []
    const spying: ActionReader = { ...mcpReader, actionsOf: (call) => (seen.push(call), []) }
    handleHook('PostToolUse', mcp('PostToolUse', 'app#2', 'Next', { tool_response: { ok: false } }), deps(spying))
    handleHook('PreToolUse', mcp('PreToolUse', 'app#2', 'Next'), deps(spying))
    assert.deepEqual(seen.map((call) => call.response), [{ ok: false }, undefined])
  })

  it('is not read by the GitHub reader, so a team without a module is unchanged', () => {
    const result = handleHook('PostToolUse', mcp('PostToolUse', 'app#2', 'In Progress'), deps(bashActionReader(config)))
    assert.equal(loadSnapshot(p)?.items.find((item) => item.number === 2)?.status, 'Backlog')
    assert.doesNotMatch(context(result), /you just touched/)
  })
})

describe('the hooks\' tool matcher', () => {
  const matcherOf = (tools?: readonly string[]) => (withHooks({}, '/x/scrum-harness/bin/scrum', tools).hooks?.PreToolUse?.[0] as { matcher?: string }).matcher

  it('is Bash alone by default, and adds the configured tools', () => {
    assert.equal(matcherOf(), 'Bash')
    assert.equal(matcherOf(['mcp__tracker__.*', 'mcp__other__set_status']), 'Bash|mcp__tracker__.*|mcp__other__set_status')
  })

  it('is written by `scrum install` from the configuration, and replaced the next time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrum-matcher-'))
    const settings = join(dir, 'settings.json')
    writeFileSync(settings, '{}')
    const state = paths(mkdtempSync(join(tmpdir(), 'scrum-matcher-state-')))
    writeFileSync(join(state.dir, 'config.json'), '{}')
    installCommand(state, true, [settings], ['mcp__tracker__.*'])
    assert.equal(JSON.parse(readFileSync(settings, 'utf8')).hooks.PreToolUse.length, 1)
    installCommand(state, true, [settings], [])
    const groups = JSON.parse(readFileSync(settings, 'utf8')).hooks.PreToolUse as { matcher: string }[]
    assert.deepEqual(groups.map((group) => group.matcher), ['Bash'])
  })

  it('is read from `hookTools`, which has to be names, not shell or regex syntax beyond * and .', () => {
    assert.deepEqual(parseConfig({ ...base, hookTools: ['mcp__tracker__.*'] })?.hookTools, ['mcp__tracker__.*'])
    for (const bad of [['mcp (x)'], ['a|b'], [''], 'mcp__x', [7]]) assert.equal(parseConfig({ ...base, hookTools: bad }), null, JSON.stringify(bad))
    assert.equal(parseConfig(base)?.hookTools, undefined)
  })
})
