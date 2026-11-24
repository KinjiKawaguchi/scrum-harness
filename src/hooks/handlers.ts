import { checkGuard } from '../board/commands.ts'
import { loadSnapshot } from '../board/snapshot.ts'
import type { Config } from '../config.ts'
import type { Ports } from '../ports/index.ts'
import type { Paths } from '../store.ts'
import { dueCheckpoint, loadRecords } from '../sprint/record.ts'
import { writeHeartbeat } from '../team/heartbeat.ts'
import { roleOf, type Identity } from '../team/identity.ts'
import type { ActivityState } from '../team/types.ts'
import { techleadAfterBash, techleadDiff, techleadSessionStart, techleadStop } from './techlead.ts'

export type HookDeps = {
  readonly p: Paths
  readonly config: Config
  readonly now: Date
  readonly identity: Identity | null
  /** 操作の読み取り (actions)、PR が触れている issue (code)、稼働 (sessions) を使う */
  readonly ports: Pick<Ports, 'actions' | 'code' | 'sessions'>
  /** ボードの取り直しを裏で始める */
  readonly spawnRefresh: () => void
  /** 節目の記録を裏で始める */
  readonly spawnCheckpoint: () => void
}

export type HookInput = Record<string, unknown>

/** stdout に書く JSON と終了コード。stdout が無ければ何も出さない。 */
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

function guard(input: HookInput, deps: HookDeps): HookResult {
  const command = bashCommand(input)
  const snapshot = loadSnapshot(deps.p)
  if (command === null || snapshot === null) return NOTHING
  const reason = checkGuard(snapshot, deps.ports.actions.commandsOf(command), deps.config, command)
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
      const command = bashCommand(input)
      return inject(event, command === null ? techleadDiff(deps) : techleadAfterBash(deps, command))
    }
    case 'Stop': {
      const reason = techleadStop(deps, input.stop_hook_active === true)
      return reason === null ? NOTHING : { exitCode: 0, stdout: { decision: 'block', reason } }
    }
    default:
      return NOTHING
  }
}

/**
 * フックの入口。チームの外のセッションでは何もしない。どの役でも心拍を書き、記録していない節目があれば
 * 記録を裏で始める (TechLead のターンの区切りを待たずに、チームの誰かが動けば記録されるように)。
 * TechLead にだけ指摘を入れる。書き込みのガードは役に関係なく効かせる。
 */
export function handleHook(event: string, input: HookInput, deps: HookDeps): HookResult {
  if (event === 'PreToolUse') return guard(input, deps)
  const identity = deps.identity
  const role = identity === null ? null : roleOf(identity.name, deps.config)
  if (identity === null || role === null) return NOTHING
  const state = heartbeatState(event, input)
  if (state !== null) writeHeartbeat(deps.p, identity, state, deps.now)
  if (dueCheckpoint(loadRecords(deps.p), deps.config, deps.now) !== null) deps.spawnCheckpoint()
  return role === 'techlead' ? techlead(event, input, deps) : NOTHING
}
