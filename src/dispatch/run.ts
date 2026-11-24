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

/** 渡すのに失敗したあと、次に試すまで待つ時間。失敗が続いても、30 秒ごとには試さない。 */
const FAILURE_BACKOFF_MS = 5 * 60_000

export type DispatchOutcome = { readonly message: string; readonly record: DispatchRecord }

/** 渡すときに使うポート。ボードに書き、ブランチを用意し、作業の印を読み、部下の稼働を読む。 */
export type DispatchPorts = Pick<Ports, 'writer' | 'code' | 'sessions'>

/** 紐づいたブランチを用意する。失敗しても、渡すことは止めない (文面に、用意できなかったと書く)。 */
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
 * 空いている部下に、次の仕事を送る (LLM は通さない)。止まっていない自分の作業中の issue があれば、新しい issue は
 * 渡さず、それを進めるよう促す (ボードは書き換えない)。無いか、止まっていれば、決まった順で次の issue を渡す。
 * 渡すときは、ボードの担当と Status を書き換える。どちらも記録を残し、部下に送る文面を返す。
 * 送らないとき (空いていない、受け入れがある、渡せるものが無い、失敗) は null。
 * 錠の中で控えを読み直し、同じ issue を 2 人に渡さない。
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
    // 書き込む前に、ボードへの書き込みの守りと同じ検査 (作業中の上限、除く作者の作業中も数える) を通す。通らなければ、渡さない
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
 * 部下の Stop と SessionStart から asyncRewake で起動する。ボードを定期的に取り直し、この人に渡す時が来たら、
 * 渡して、その文を返す (exit 2 でこのセッションを起こす)。部下ごとに 1 つだけ動く。
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
