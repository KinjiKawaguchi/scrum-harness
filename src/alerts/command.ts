import { isRefreshDue, refreshSnapshot } from '../board/snapshot.ts'
import type { Config } from '../config.ts'
import type { Paths } from '../store.ts'
import { alertsOf } from './config.ts'
import { realNotify, type Notify } from './desktop.ts'
import { alertStep } from './run.ts'
import { readAlertState } from './state.ts'

/**
 * `scrum alerts`: 止まりの検知を 1 回進める (待機プロセスの 1 周と同じ。ボードの控えが古ければ取り直し、macOS の通知を、まだなら出す)。
 * 待機プロセスの寿命 (50 分) が E-STALL の上限 (60 分) より短く、全員が静かな夜は待機が止まるので、launchd が 5 分ごとに流す。LLM は通らない。
 * 窓口に送る文は作らない (窓口の待機プロセスが作る)。
 */
export type AlertsCommandDeps = {
  readonly notify: Notify
  /** ボードの控えを取り直す。試験で、本物の gh を呼ばないために差し替える */
  readonly refresh: (p: Paths, config: Config, now: Date) => unknown
}

const REAL_DEPS: AlertsCommandDeps = { notify: realNotify, refresh: refreshSnapshot }

export function alertsCommand(p: Paths, config: Config, now: Date, deps: Partial<AlertsCommandDeps> = {}): string {
  const { notify, refresh } = { ...REAL_DEPS, ...deps }
  if (!alertsOf(config).enabled) return 'alerts が有効でない (設定の alerts.enabled が true のときだけ動く)'
  if (isRefreshDue(p, config, now)) refresh(p, config, now)
  alertStep(p, config, now, { notify, isLiaison: false })
  const state = readAlertState(p)
  return `止まりの検知を進めた: 動く人のいない Epic ${Object.keys(state.epics).length} 件、渡せる issue が無い部下 ${Object.keys(state.empty).length} 人`
}
