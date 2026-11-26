import { checkGuard } from '../board/commands.ts'
import { loadSnapshot } from '../board/snapshot.ts'
import type { Config } from '../config.ts'
import type { Ports, ToolCall } from '../ports/index.ts'
import type { Paths } from '../store.ts'
import { dueCheckpoint, loadRecords } from '../sprint/record.ts'
import { writeHeartbeat } from '../team/heartbeat.ts'
import { openedPullRequest, recordPrAuthor } from '../team/pr-authors.ts'
import { roleOf, type Identity } from '../team/identity.ts'
import type { ActivityState } from '../team/types.ts'
import { techleadAfterTool, techleadDiff, techleadSessionStart, techleadStop } from './techlead.ts'

export type HookDeps = {
  readonly p: Paths
  readonly config: Config
  readonly now: Date
  readonly identity: Identity | null
  /** Uses the reading of operations (actions), the issues that a PR touches (code), and activity (sessions) */
  readonly ports: Pick<Ports, 'actions' | 'code' | 'sessions'>
  /** Starts the board re-fetch in the background */
  readonly spawnRefresh: () => void
  /** Starts the checkpoint recording in the background */
  readonly spawnCheckpoint: () => void
}

export type HookInput = Record<string, unknown>

/** The JSON written to stdout and the exit code. If there is no stdout, nothing is output. */
export type HookResult = { readonly stdout?: unknown; readonly exitCode: 0 }

const NOTHING: HookResult = { exitCode: 0 }

function inject(event: string, text: string): HookResult {
  if (text === '') return NOTHING
  return { exitCode: 0, stdout: { hookSpecificOutput: { hookEventName: event, additionalContext: text } } }
}

const HEARTBEAT: Readonly<Record<string, ActivityState>> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'busy',
  PostToolUse: 'busy',
  Stop: 'idle',
  SessionEnd: 'ended',
}

function heartbeatState(event: string, input: HookInput): ActivityState | null {
  if (event === 'Notification') return input.notification_type === 'permission_prompt' ? 'waiting' : null
  return HEARTBEAT[event] ?? null
}

function bashCommand(input: HookInput): string | null {
  if (input.tool_name !== 'Bash') return null
  const command = (input.tool_input as { command?: unknown } | undefined)?.command
  return typeof command === 'string' ? command : null
}

/** The tool call a hook was given, of any tool (a Bash command or an MCP tool). Null when the input does not name a tool. */
function toolCall(input: HookInput): ToolCall | null {
  if (typeof input.tool_name !== 'string' || input.tool_name === '') return null
  const raw = input.tool_input
  const toolInput = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return { tool: input.tool_name, input: toolInput, ...(input.tool_response === undefined ? {} : { response: input.tool_response }) }
}

function guard(input: HookInput, deps: HookDeps): HookResult {
  const call = toolCall(input)
  const snapshot = loadSnapshot(deps.p)
  if (call === null || snapshot === null) return NOTHING
  // The escape `SCRUM_GUARD=off` is a word in a Bash command; no other tool has one.
  const reason = checkGuard(snapshot, deps.ports.actions.actionsOf(call), deps.config, bashCommand(input) ?? '')
  if (reason === null) return NOTHING
  return {
    exitCode: 0,
    stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `scrum-harness: ${reason}` } },
  }
}

function techlead(event: string, input: HookInput, deps: HookDeps): HookResult {
  switch (event) {
    case 'SessionStart':
      return inject(event, techleadSessionStart(deps))
    case 'UserPromptSubmit':
      return inject(event, techleadDiff(deps))
    case 'PostToolUse': {
      const call = toolCall(input)
      return inject(event, call === null ? techleadDiff(deps) : techleadAfterTool(deps, call))
    }
    case 'Stop': {
      const reason = techleadStop(deps, input.stop_hook_active === true)
      return reason === null ? NOTHING : { exitCode: 0, stdout: { decision: 'block', reason } }
    }
    default:
      return NOTHING
  }
}

/** Records the member whose session opened a pull request, from the tool result. */
function notePullRequest(identity: Identity, input: HookInput, deps: HookDeps): void {
  const call = toolCall(input)
  const ref = call === null ? null : openedPullRequest(call)
  if (ref !== null) recordPrAuthor(deps.p.prAuthors, { at: deps.now.toISOString(), name: identity.name, sessionId: identity.sessionId, ref })
}

/**
 * The hook's entry point. Does nothing in a session outside the team. Writes the heartbeat in every role, and if there is a checkpoint not yet recorded,
 * starts recording in the background (so that it is recorded if anyone on the team moves, without waiting for the TechLead's turn boundary).
 * Injects findings only to the TechLead. The write guard applies regardless of role.
 */
export function handleHook(event: string, input: HookInput, deps: HookDeps): HookResult {
  if (event === 'PreToolUse') return guard(input, deps)
  const identity = deps.identity
  const role = identity === null ? null : roleOf(identity.name, deps.config)
  if (identity === null || role === null) return NOTHING
  const state = heartbeatState(event, input)
  if (state !== null) writeHeartbeat(deps.p, identity, state, deps.now)
  if (event === 'PostToolUse') notePullRequest(identity, input, deps)
  if (dueCheckpoint(loadRecords(deps.p), deps.config, deps.now) !== null) deps.spawnCheckpoint()
  return role === 'techlead' ? techlead(event, input, deps) : NOTHING
}
