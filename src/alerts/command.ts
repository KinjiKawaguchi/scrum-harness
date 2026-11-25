import { isRefreshDue, refreshSnapshot } from '../board/snapshot.ts'
import type { Ports } from '../ports/index.ts'
import type { Config } from '../config.ts'
import type { Paths } from '../store.ts'
import { alertsOf } from './config.ts'
import { alertStep } from './run.ts'
import { readAlertState } from './state.ts'

/**
 * `scrum alerts`: advances stall detection by one round (same as one loop of the watch process. If the board copy is stale it is re-fetched, and a desktop notification is shown if not yet shown).
 * The watch process's lifetime (50 minutes) is shorter than the E-STALL limit (60 minutes), and on nights when everyone is quiet the watch stops, so a scheduler (scrum schedule) runs this every 5 minutes. No LLM is involved.
 * It does not build the text sent to the liaison (the liaison's watch process builds it).
 */
export function alertsCommand(p: Paths, config: Config, now: Date, ports: Pick<Ports, 'board' | 'notify' | 'sessions'>): string {
  if (!alertsOf(config).enabled) return 'alerts is not enabled (it runs only when alerts.enabled is true in the configuration)'
  if (isRefreshDue(p, config, now)) refreshSnapshot(p, config, now, ports.board)
  alertStep(p, config, now, { notify: ports.notify, sessions: ports.sessions, isLiaison: false })
  const state = readAlertState(p)
  return `Advanced the stall detection. Epics with nobody moving: ${Object.keys(state.epics).length}; members with nothing to hand over: ${Object.keys(state.empty).length}`
}
