import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bashActionReader } from '../src/adapters/github/action-reader.ts'
import { referencedLabels } from '../src/adapters/github/pull-requests.ts'
import { loadSnapshot, saveSnapshot } from '../src/board/snapshot.ts'
import { handleHook, isUsageRefusal, type HookDeps } from '../src/hooks/handlers.ts'
import { parseLaunch } from '../src/members/config.ts'
import type { Config } from '../src/config.ts'
import { paths, readJson, writeJson, type Paths } from '../src/store.ts'
import { fakePorts } from './fake-ports.ts'
import { config, issue, NOW, pr, snapshot } from './helpers.ts'

let p: Paths
let refreshes = 0
let checkpoints = 0

/** prBody is the body of the merged PR (null if it cannot be read). Picking the issue out of the body still goes through the GitHub adapter. */
type DepsOverrides = Partial<HookDeps> & { readonly prBody?: (prLabel: string, repo: string) => string | null }

function deps(name: string | null, overrides: DepsOverrides = {}): HookDeps {
  const { prBody = () => '#1 continues', ...rest } = overrides
  const used = rest.config ?? config
  const referencedIssues = (prLabel: string, repo: string) => {
    const body = prBody(prLabel, repo)
    return body === null ? null : referencedLabels(body, repo)
  }
  return {
    p,
    config: used,
    now: NOW,
    identity: name === null ? null : { sessionId: `sid-${name}`, name, pid: null },
    ports: { actions: bashActionReader(used), code: { ...fakePorts().code, referencedIssues }, sessions: fakePorts().sessions },
    spawnRefresh: () => {
      refreshes += 1
    },
    spawnMoveRefused: () => undefined,
    spawnCheckpoint: () => {
      checkpoints += 1
    },
    ...rest,
  }
}

const context = (result: ReturnType<typeof handleHook>) =>
  (result.stdout as { hookSpecificOutput?: { additionalContext?: string } } | undefined)?.hookSpecificOutput?.additionalContext ?? ''

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-hooks-')))
  refreshes = 0
  checkpoints = 0
  saveSnapshot(p, snapshot([issue(1, { status: 'In Progress' }), issue(2), pr(102, { state: 'OPEN' })]))
})

describe('TechLead', () => {
  it('puts the summary in at SessionStart and remembers the findings announced', () => {
    const result = handleHook('SessionStart', { session_id: 'sid', source: 'startup' }, deps('TechLead'))
    assert.match(context(result), /B-DOING-NO-ASSIGNEE app#1 is In Progress but has no assignee/)
    assert.deepEqual(readJson(p.notified, []), ['B-DOING-NO-ASSIGNEE:app#1'])
  })

  it('at UserPromptSubmit, puts in only the findings not yet announced', () => {
    handleHook('SessionStart', { source: 'startup' }, deps('TechLead'))
    assert.equal(context(handleHook('UserPromptSubmit', {}, deps('TechLead'))), '')
    saveSnapshot(p, snapshot([...(loadSnapshot(p)?.items ?? []), issue(3, { state: 'CLOSED', status: 'In Progress' })]))
    assert.match(context(handleHook('UserPromptSubmit', {}, deps('TechLead'))), /B-CLOSED-NOT-DONE app#3/)
  })

  it('after set-status, updates the board copy and puts in the findings for that issue', () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'set-status 2 "In Progress"' } }
    const text = context(handleHook('PostToolUse', input, deps('TechLead')))
    assert.match(text, /app#2 is In Progress but has no assignee/)
    assert.equal(loadSnapshot(p)?.items.find((item) => item.number === 2)?.status, 'In Progress')
  })

  it('after a merge, puts in the state of the issues the body touches', () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'merge-pr example-org/app 102' } }
    assert.match(context(handleHook('PostToolUse', input, deps('TechLead'))), /app#102 was merged[\s\S]*app#1 Status=In Progress/)
  })

  it('reads the PR body in the repository the command pointed at (does not mistake a repository missing from the config for defaultRepo)', () => {
    const asked: (readonly [string, string])[] = []
    const input = { tool_name: 'Bash', tool_input: { command: 'gh pr merge 3 -R other-owner/tool --squash' } }
    handleHook('PostToolUse', input, deps('TechLead', { prBody: (prLabel, repo) => (asked.push([prLabel, repo]), null) }))
    assert.deepEqual(asked, [['tool#3', 'other-owner/tool']])
  })

  it('even a merge in the shape of the merge-pr script reads the body of a PR from a repository different from defaultRepo, in that repository, and builds the guidance', () => {
    saveSnapshot(p, snapshot([...(loadSnapshot(p)?.items ?? []), { ...issue(1, { status: 'In Progress' }), repo: 'other-owner/tool' }]))
    const asked: (readonly [string, string])[] = []
    const input = { tool_name: 'Bash', tool_input: { command: 'merge-pr other-owner/tool 3 abc123' } }
    const text = context(
      handleHook('PostToolUse', input, deps('TechLead', { prBody: (prLabel, repo) => (asked.push([prLabel, repo]), '#1 continues') })),
    )
    assert.deepEqual(asked, [['tool#3', 'other-owner/tool']])
    assert.match(text, /tool#3 was merged[\s\S]*tool#1 Status=In Progress/)
  })

  it('the merge of a PR in another repository reads the numbers the body touches as issues of that repository', () => {
    saveSnapshot(p, snapshot([...(loadSnapshot(p)?.items ?? []), { ...issue(1, { status: 'In Progress' }), repo: 'other-owner/tool' }]))
    const input = { tool_name: 'Bash', tool_input: { command: 'gh pr merge 3 -R other-owner/tool --squash' } }
    const text = context(handleHook('PostToolUse', input, deps('TechLead', { prBody: () => '#1 continues' })))
    assert.match(text, /tool#3 was merged[\s\S]*tool#1 Status=In Progress/)
    assert.doesNotMatch(text, /tool#3 was merged[\s\S]*app#1 Status/)
  })

  it("once announced, clears the watch process's marker", () => {
    writeJson(p.pending, true)
    handleHook('UserPromptSubmit', {}, deps('TechLead'))
    assert.equal(existsSync(p.pending), false)
  })

  it('after a board rewrite that bypasses the script, refreshes the board', () => {
    handleHook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'gh project item-edit --id X' } }, deps('TechLead'))
    assert.equal(refreshes, 1)
  })

  it('at PreToolUse, refuses a Status on a PR', () => {
    const result = handleHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'set-status 102 "In Progress"' } }, deps('TechLead'))
    assert.deepEqual((result.stdout as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny')
  })

  it('Stop blocks once, only when there is a high finding that has never been blocked', () => {
    const first = handleHook('Stop', { stop_hook_active: false }, deps('TechLead'))
    assert.equal((first.stdout as { decision?: string }).decision, 'block')
    assert.match((first.stdout as { reason: string }).reason, /app#1/)
    assert.equal(handleHook('Stop', { stop_hook_active: false }, deps('TechLead')).stdout, undefined)
  })

  it('Stop does not block when stop_hook_active is set', () => {
    assert.equal(handleHook('Stop', { stop_hook_active: true }, deps('TechLead')).stdout, undefined)
  })

  it('does not block when isStopBlockEnabled is false', () => {
    const off = deps('TechLead', { config: { ...config, isStopBlockEnabled: false } })
    assert.equal(handleHook('Stop', { stop_hook_active: false }, off).stdout, undefined)
  })
})

describe('members and other sessions', () => {
  it("a member's hook writes only the heartbeat and puts nothing in", () => {
    const busy = handleHook('PostToolUse', { tool_name: 'Read', tool_input: {} }, deps('SWE1'))
    assert.equal(busy.stdout, undefined)
    const beat = readJson<{ state: string } | null>(join(p.heartbeats, 'sid-SWE1.json'), null)
    assert.equal(beat?.state, 'busy')
    handleHook('Stop', { stop_hook_active: false }, deps('SWE1'))
    assert.equal(readJson<{ state: string } | null>(join(p.heartbeats, 'sid-SWE1.json'), null)?.state, 'idle')
  })

  it('a notification asking for permission marks the member as waiting for permission', () => {
    handleHook('Notification', { notification_type: 'permission_prompt' }, deps('SWE1'))
    assert.equal(readJson<{ state: string } | null>(join(p.heartbeats, 'sid-SWE1.json'), null)?.state, 'waiting')
  })

  it('does nothing in a session outside the team', () => {
    const result = handleHook('Stop', { stop_hook_active: false }, deps(null))
    assert.equal(result.stdout, undefined)
    assert.throws(() => readdirSync(p.heartbeats))
  })
})

describe('starting the checkpoint record', () => {
  const sprint = {
    checkpoints: ['08:00', '13:00', '21:00'],
    utcOffset: '+09:00',
    pointsField: 'Story points',
    pointBudgets: { '3': 2 },
  }
  const withSprint = (name: string | null) => deps(name, { config: { ...config, sprint } })

  it("when there is a checkpoint not yet recorded, starts recording in the background even from a member's hook", () => {
    handleHook('Stop', { stop_hook_active: false }, withSprint('SWE1'))
    assert.equal(checkpoints, 1)
  })

  it("also starts from the TechLead's hook", () => {
    handleHook('UserPromptSubmit', {}, withSprint('TechLead'))
    assert.equal(checkpoints, 1)
  })

  it('does not start in a session outside the team or when there is no sprint config', () => {
    handleHook('Stop', { stop_hook_active: false }, withSprint(null))
    handleHook('Stop', { stop_hook_active: false }, deps('SWE1'))
    assert.equal(checkpoints, 0)
  })
})

describe('a turn that ended because the subscription refused it', () => {
  const funding = (isAutoMove: boolean): Config => ({ ...config, members: ['SWE1'], launch: parseLaunch({ tmuxSession: 'team', funding: { command: ['/usr/local/bin/agency'], ...(isAutoMove ? { autoMove: true } : {}) }, members: { SWE1: {} } }) })
  const refusal = { hook_event_name: 'StopFailure', session_id: 'sid', error: 'rate_limit', last_assistant_message: "You've hit your weekly limit" }

  it('moves the member that was refused, by name, in a process of its own', () => {
    const moved: string[] = []
    handleHook('StopFailure', refusal, deps('SWE1', { config: funding(true), spawnMoveRefused: (name: string) => void moved.push(name) }))
    assert.deepEqual(moved, ['SWE1'])
  })

  it('moves the team\'s lead too when it is refused: the rule has no exception for it', () => {
    const moved: string[] = []
    handleHook('StopFailure', refusal, deps('TechLead', { config: funding(true), spawnMoveRefused: (name: string) => void moved.push(name) }))
    assert.deepEqual(moved, ['TechLead'])
  })

  it('does nothing for another error, without autoMove, or for a session outside the team', () => {
    const moved: string[] = []
    const spawnMoveRefused = (name: string) => void moved.push(name)
    handleHook('StopFailure', { ...refusal, error: 'server_error' }, deps('SWE1', { config: funding(true), spawnMoveRefused }))
    handleHook('StopFailure', refusal, deps('SWE1', { config: funding(false), spawnMoveRefused }))
    handleHook('StopFailure', refusal, deps('Stranger', { config: funding(true), spawnMoveRefused }))
    handleHook('StopFailure', refusal, deps(null, { config: funding(true), spawnMoveRefused }))
    assert.deepEqual(moved, [])
    assert.equal(isUsageRefusal(refusal), true)
    assert.equal(isUsageRefusal({ ...refusal, hook_event_name: 'Stop' }), false)
  })
})
