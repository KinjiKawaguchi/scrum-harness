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
 * 窓口に送る文。何を誰に伝えるかはハーネスが決めてあり、窓口はこの文のとおりに送る手になる。
 * オーナーへの通知を先に、空きの 1 行と、オーナーへは送らないと決めた通知の 1 行を後に並べる。
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
 * 窓口の Stop と SessionStart から asyncRewake で起動する。ボードを定期的に取り直し、止まりの検知を進め、
 * 窓口に送る通知が出たら、その文を返す (exit 2 で窓口を起こす)。窓口ごとに 1 つだけ動く。
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
