import { rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { isRefreshDue, refreshSnapshot } from './board/snapshot.ts'
import { alertStep } from './alerts/run.ts'
import { hasCodeChanged, SOURCE_DIR } from './code-change.ts'
import type { Config } from './config.ts'
import { runLinksIfDue } from './links/run.ts'
import { runCheckpoint } from './sprint/checkpoint-run.ts'
import { formatList } from './findings/format.ts'
import { lintAll, loadContext, type LintContext } from './findings/lint.ts'
import { remember, unseen } from './findings/notify.ts'
import { atLeast, type Finding } from './findings/types.ts'
import { transitions, type MetricsState } from './metrics/events.ts'
import type { Ports } from './ports/index.ts'
import { appendLine, logError, readJson, releaseLock, tryLock, writeJson, type Paths } from './store.ts'

/** 待機中の TechLead を起こす指摘。TechLead が作業中なら、フックで入るので起こさない。 */
export function decideWake(ctx: LintContext, notified: readonly string[]): readonly Finding[] {
  const techlead = ctx.members.find((member) => member.name === ctx.config.techlead)
  if (techlead?.state === 'busy') return []
  return unseen(lintAll(ctx).active, notified, 'medium')
}

/** TechLead が作業中で、知らせていない指摘があるか。あれば印を置き、次のツールの呼び出しのフックで入れる。 */
export function hasPending(ctx: LintContext, notified: readonly string[]): boolean {
  const techlead = ctx.members.find((member) => member.name === ctx.config.techlead)
  if (techlead?.state !== 'busy') return false
  return unseen(lintAll(ctx).active, notified, 'medium').length > 0
}

function markPending(p: Paths, isPending: boolean): void {
  if (isPending) writeJson(p.pending, true)
  else rmSync(p.pending, { force: true })
}

function recordMetrics(p: Paths, ctx: LintContext): void {
  const { active, acked } = lintAll(ctx)
  const tracked = [...active, ...acked].filter(atLeast('medium'))
  const prev = readJson<MetricsState>(p.metricsState, { open: {}, members: {} })
  const { events, next } = transitions(prev, tracked, ctx.members, ctx.now)
  events.forEach((event) => appendLine(p.events, JSON.stringify(event)))
  writeJson(p.metricsState, next)
}

export type WatchOptions = { readonly maxMs: number; readonly intervalMs: number }

function step(p: Paths, config: Config, ports: Ports): string | null {
  const now = new Date()
  if (isRefreshDue(p, config, now)) refreshSnapshot(p, config, now, ports.board)
  runLinksIfDue(p, config, now, ports)
  runCheckpoint(p, config, now, ports)
  alertStep(p, config, now, { notify: ports.notify, sessions: ports.sessions, isLiaison: false })
  const ctx = loadContext(p, config, now, ports.sessions)
  recordMetrics(p, ctx)
  const notified = readJson<readonly string[]>(p.notified, [])
  markPending(p, hasPending(ctx, notified))
  const wake = decideWake(ctx, notified)
  if (wake.length === 0) return null
  writeJson(p.notified, remember(notified, lintAll(ctx).active, wake))
  appendLine(p.events, JSON.stringify({ at: now.toISOString(), type: 'woke', keys: wake.map((f) => f.key) }))
  return ['scrum-harness: a new finding appeared while waiting', ...formatList(wake, 8)].join('\n')
}

/**
 * TechLead の Stop と SessionStart から asyncRewake で起動する。ボードを定期的に取り直し、
 * 知らせていない指摘が出たら、その文を返して exit 2 で TechLead を起こす。1つだけ動く。
 */
export async function runWatch(p: Paths, config: Config, options: WatchOptions, ports: Ports): Promise<string | null> {
  if (!tryLock(p.watchLock)) return null
  const startedAt = Date.now()
  const deadline = startedAt + options.maxMs
  try {
    while (Date.now() < deadline && !hasCodeChanged(SOURCE_DIR, startedAt)) {
      const message = step(p, config, ports)
      if (message !== null) return message
      await sleep(options.intervalMs)
    }
    return null
  } catch (error) {
    logError(p, 'watch', error)
    return null
  } finally {
    releaseLock(p.watchLock)
  }
}
