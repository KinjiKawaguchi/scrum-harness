import { setTimeout as sleep } from 'node:timers/promises'
import { alertStep } from '../alerts/run.ts'
import { applyCommands, checkGuard } from '../board/commands.ts'
import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import { isRefreshDue, refreshSnapshot, saveSnapshot } from '../board/snapshot.ts'
import { hasCodeChanged, SOURCE_DIR } from '../code-change.ts'
import { dispatchOf, type Config } from '../config.ts'
import { loadContext } from '../findings/lint.ts'
import type { LinkOutcome, Ports } from '../ports/index.ts'
import { appendLine, logError, readJson, releaseLock, tryLock, writeJson, type Paths } from '../store.ts'
import { decideAction } from './decide.ts'
import { idleGate } from './due.ts'
import { dispatchMessage, nudgeMessage } from './message.ts'
import { observe, readSeen, tokenWith, writeSeen } from './progress.ts'
import { appendDispatch } from './records.ts'
import type { DispatchRecord } from './types.ts'

/** The time to wait before trying again after a hand-over failed. Even if failures continue, it does not try every 30 seconds. */
const FAILURE_BACKOFF_MS = 5 * 60_000

export type DispatchOutcome = { readonly message: string; readonly record: DispatchRecord }

/** The ports used when handing over. They write to the board, prepare the branch, read work markers, and read members' activity. */
export type DispatchPorts = Pick<Ports, 'writer' | 'code' | 'sessions'>

/** Prepares the linked branch. Even on failure, the hand-over is not stopped (the text says it could not be prepared). */
function linkBranch(p: Paths, code: Ports['code'], item: BoardItem): LinkOutcome {
  try {
    return code.prepareBranch(item)
  } catch (error) {
    logError(p, 'dispatch-link', error)
    return 'failed'
  }
}

function isBackingOff(p: Paths, now: Date): boolean {
  const failedAt = readJson<string | null>(p.dispatchFailure, null)
  return failedAt !== null && now.getTime() - Date.parse(failedAt) < FAILURE_BACKOFF_MS
}

/**
 * Sends the next work to a free member (without going through the LLM). If they have their own In Progress issue that is not blocked, no new issue is
 * handed over, and they are nudged to advance it (the board is not rewritten). If there is none, or it is blocked, the next issue is handed over in the fixed order.
 * On a handover, the board's assignee and Status are rewritten. Both leave a record, and the text to send to the member is returned.
 * null when nothing is sent (not free, an acknowledgement exists, nothing to hand over, a failure).
 * Inside the lock the board copy is re-read, so the same issue is not handed to two people.
 */
export function dispatchStep(
  p: Paths,
  config: Config,
  memberName: string,
  now: Date,
  ports: DispatchPorts,
): DispatchOutcome | null {
  if (!dispatchOf(config).enabled || !ports.writer.canAssign || isBackingOff(p, now)) return null
  const quick = loadContext(p, config, now, ports.sessions)
  const quickMember = quick.members.find((member) => member.name === memberName)
  if (quickMember === undefined || !idleGate(quickMember, quick.acks, config, now).isDue) return null
  if (!tryLock(p.dispatchLock)) return null
  try {
    const ctx = loadContext(p, config, now, ports.sessions)
    const member = ctx.members.find((one) => one.name === memberName)
    if (member === undefined || ctx.snapshot === null || !idleGate(member, ctx.acks, config, now).isDue) return null
    const seen = readSeen(p)
    const action = decideAction(ctx.snapshot, member, ctx.dispatches ?? [], config, now, tokenWith(ports.code.activity), seen)
    if (action.kind === 'none') {
      if (action.reason === 'progressing') writeSeen(p, observe(seen, memberName, label(action.item), action.token, now))
      return null
    }
    const { item } = action
    if (action.kind === 'nudge') {
      writeSeen(p, observe(seen, memberName, label(item), action.token, now))
      const record: DispatchRecord = { kind: 'nudge', at: now.toISOString(), member: memberName, label: label(item), title: item.title, progress: action.token }
      appendDispatch(p, record)
      appendLine(p.events, JSON.stringify({ type: 'nudged', count: action.count, ...record }))
      return { message: nudgeMessage(item, memberName, config), record }
    }
    // Before writing, runs the same check as the guard on writes to the board (In Progress limit; In Progress by excluded authors is also counted). If it does not pass, nothing is handed over
    const setDoing = { kind: 'set-status', label: label(item), status: config.statuses.doing } as const
    if (checkGuard(ctx.snapshot, [setDoing], config) !== null) return null
    if (item.assignee !== memberName) ports.writer.assign(item, memberName)
    ports.writer.setStatus(item, config.statuses.doing)
    const branch = linkBranch(p, ports.code, item)
    const record: DispatchRecord = { at: now.toISOString(), member: memberName, label: label(item), title: item.title, ...(typeof branch === 'object' && branch !== null ? { branch: branch.name } : {}) }
    appendDispatch(p, record)
    appendLine(p.events, JSON.stringify({ type: 'dispatched', tier: action.tier, ...record }))
    const commands = [
      { kind: 'set-assignee', label: record.label, assignee: memberName },
      { kind: 'set-status', label: record.label, status: config.statuses.doing },
    ] as const
    saveSnapshot(p, applyCommands(ctx.snapshot, commands, config, now.toISOString().slice(0, 10)))
    return { message: dispatchMessage(item, memberName, config, branch), record }
  } catch (error) {
    logError(p, 'dispatch', error)
    writeJson(p.dispatchFailure, now.toISOString())
    return null
  } finally {
    releaseLock(p.dispatchLock)
  }
}

export type MemberWatchOptions = { readonly maxMs: number; readonly intervalMs: number }

/**
 * Started with asyncRewake from a member's Stop and SessionStart. Re-fetches the board periodically, and when the time comes to hand over to this person,
 * hands over and returns that text (exit 2 wakes this session). Only one runs per member.
 */
export async function runMemberWatch(
  p: Paths,
  config: Config,
  memberName: string,
  options: MemberWatchOptions,
  ports: Ports,
): Promise<string | null> {
  const lock = p.memberWatchLock(memberName)
  if (!tryLock(lock)) return null
  const startedAt = Date.now()
  const deadline = startedAt + options.maxMs
  try {
    while (Date.now() < deadline && !hasCodeChanged(SOURCE_DIR, startedAt)) {
      const now = new Date()
      if (isRefreshDue(p, config, now)) refreshSnapshot(p, config, now, ports.board)
      const outcome = dispatchStep(p, config, memberName, now, ports)
      alertStep(p, config, now, { notify: ports.notify, sessions: ports.sessions, isLiaison: false })
      if (outcome !== null) return outcome.message
      await sleep(options.intervalMs)
    }
    return null
  } catch (error) {
    logError(p, 'dispatch-watch', error)
    return null
  } finally {
    releaseLock(lock)
  }
}
