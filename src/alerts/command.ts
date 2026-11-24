import { isRefreshDue, refreshSnapshot } from '../board/snapshot.ts'
import type { Ports } from '../ports/index.ts'
import type { Config } from '../config.ts'
import type { Paths } from '../store.ts'
import { alertsOf } from './config.ts'
import { alertStep } from './run.ts'
import { readAlertState } from './state.ts'

/**
 * `scrum alerts`: 止まりの検知を 1 回進める (待機プロセスの 1 周と同じ。ボードの控えが古ければ取り直し、macOS の通知を、まだなら出す)。
 * 待機プロセスの寿命 (50 分) が E-STALL の上限 (60 分) より短く、全員が静かな夜は待機が止まるので、launchd が 5 分ごとに流す。LLM は通らない。
 * 窓口に送る文は作らない (窓口の待機プロセスが作る)。
 */
export function alertsCommand(p: Paths, config: Config, now: Date, ports: Pick<Ports, 'board' | 'notify' | 'sessions'>): string {
  if (!alertsOf(config).enabled) return 'alerts is not enabled (it runs only when alerts.enabled is true in the configuration)'
  if (isRefreshDue(p, config, now)) refreshSnapshot(p, config, now, ports.board)
  alertStep(p, config, now, { notify: ports.notify, sessions: ports.sessions, isLiaison: false })
  const state = readAlertState(p)
  return `Advanced the stall detection. Epics with nobody moving: ${Object.keys(state.epics).length}; members with nothing to hand over: ${Object.keys(state.empty).length}`
}
