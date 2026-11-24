import { alertsOf } from './alerts/config.ts'
import { runLiaisonWatch } from './alerts/liaison.ts'
import { dispatchOf, type Config } from './config.ts'
import { runMemberWatch } from './dispatch/run.ts'
import type { Ports } from './ports/index.ts'
import type { Paths } from './store.ts'
import { roleOf } from './team/identity.ts'
import { runWatch } from './watch.ts'

export type RoleWatchOptions = { readonly maxMs: number; readonly intervalMs: number }

/**
 * 待機プロセスの入口。セッションの役に応じて待つものが違う。起こすときは、その文を返す。
 * TechLead は指摘を待つ。部下は dispatch が有効なときだけ、次の仕事を渡される時を待つ。
 * 窓口は alerts が有効なときだけ、止まりの検知が決めた通知の文を待つ。チームの外は何も待たない。
 */
export async function watchFor(p: Paths, config: Config, name: string, options: RoleWatchOptions, ports: Ports): Promise<string | null> {
  const role = roleOf(name, config)
  if (role === 'techlead') return runWatch(p, config, options, ports)
  if (role === 'liaison') return alertsOf(config).enabled ? runLiaisonWatch(p, config, name, options, ports) : null
  const isTarget = role === 'member' && dispatchOf(config).enabled && (dispatchOf(config).members ?? config.members).includes(name)
  return isTarget ? runMemberWatch(p, config, name, options, ports) : null
}
