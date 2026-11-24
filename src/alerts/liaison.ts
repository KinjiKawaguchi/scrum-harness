import { setTimeout as sleep } from 'node:timers/promises'
import { isRefreshDue, refreshSnapshot } from '../board/snapshot.ts'
import { hasCodeChanged, SOURCE_DIR } from '../code-change.ts'
import type { Config } from '../config.ts'
import { logError, releaseLock, tryLock, type Paths } from '../store.ts'
import { alertsOf } from './config.ts'
import type { Ports } from '../ports/index.ts'
import { alertStep } from './run.ts'
import type { Notice } from './types.ts'

/**
 * The text sent to the liaison. The harness has decided what to tell to whom, and the liaison acts as the hand that sends exactly this text.
 * Notifications to the owner are lined up first, followed by the one-line free-member entries and the one line for a notification decided not to be sent to the owner.
 */
export function liaisonMessage(notices: readonly Notice[], config: Config): string {
  const owner = notices.filter((notice) => notice.kind === 'owner')
  const others = notices.filter((notice) => notice.kind !== 'owner')
  const desktop = owner.length > 0 && alertsOf(config).isDesktopEnabled
  return [
    'scrum-harness: notice for the liaison (decided by the harness; handle it without changing the content)',
    ...owner.map((notice) => notice.text),
    ...others.map((notice) => notice.text),
    ...(desktop ? [`(The notice to ${config.ownerLabel} is also shown directly by the harness as a macOS notification, without sound)`] : []),
  ].join('\n')
}

export type LiaisonWatchOptions = { readonly maxMs: number; readonly intervalMs: number }

/**
 * Started with asyncRewake from the liaison's Stop and SessionStart. Re-fetches the board periodically, advances stall detection, and
 * when a notification to send to the liaison appears, returns its text (exit 2 wakes the liaison). Only one runs per liaison.
 */
export async function runLiaisonWatch(
  p: Paths,
  config: Config,
  name: string,
  options: LiaisonWatchOptions,
  ports: Ports,
): Promise<string | null> {
  const lock = p.memberWatchLock(name)
  if (!tryLock(lock)) return null
  const startedAt = Date.now()
  const deadline = startedAt + options.maxMs
  try {
    while (Date.now() < deadline && !hasCodeChanged(SOURCE_DIR, startedAt)) {
      const now = new Date()
      if (isRefreshDue(p, config, now)) refreshSnapshot(p, config, now, ports.board)
      const notices = alertStep(p, config, now, { notify: ports.notify, sessions: ports.sessions, isLiaison: true })
      if (notices.length > 0) return liaisonMessage(notices, config)
      await sleep(options.intervalMs)
    }
    return null
  } catch (error) {
    logError(p, 'liaison-watch', error)
    return null
  } finally {
    releaseLock(lock)
  }
}
