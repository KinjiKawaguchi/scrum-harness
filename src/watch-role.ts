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
 * The watch process's entry point. What it waits for differs by the session's role. When it wakes, it returns that text.
 * The TechLead waits for findings. A member waits for the moment the next work is handed over, only when dispatch is enabled.
 * The liaison waits for the notification text that stall detection decided, only when alerts is enabled. Someone outside the team waits for nothing.
 */
export async function watchFor(p: Paths, config: Config, name: string, options: RoleWatchOptions, ports: Ports): Promise<string | null> {
  const role = roleOf(name, config)
  if (role === 'techlead') return runWatch(p, config, options, ports)
  if (role === 'liaison') return alertsOf(config).enabled ? runLiaisonWatch(p, config, name, options, ports) : null
  const isTarget = role === 'member' && dispatchOf(config).enabled && (dispatchOf(config).members ?? config.members).includes(name)
  return isTarget ? runMemberWatch(p, config, name, options, ports) : null
}
