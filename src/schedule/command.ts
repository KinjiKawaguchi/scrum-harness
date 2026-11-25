import type { ScheduledJob, Scheduler, ScheduleSetup } from '../ports/index.ts'

/** The background loop: stall detection (E-STALL, Q-EMPTY) once every 5 minutes. The watch process lives for 50 minutes, shorter than the 60-minute limit. */
export const ALERTS_JOB: ScheduledJob = { name: 'alerts', args: ['alerts'], everySeconds: 300 }

export const SCHEDULE_USAGE = 'Usage: scrum schedule <install|uninstall|status|print> [--name <team>]'

export type ScheduleResult = { readonly ok: boolean; readonly text: string }

/**
 * `scrum schedule`: puts the background loop under this platform's scheduler. `print` shows the files that `install` would write, and writes nothing.
 * `setup` is the machine's values (or the message why they cannot be worked out); `scheduler` is null on a platform with no adapter.
 */
export function scheduleCommand(action: string, scheduler: Scheduler | null, setup: ScheduleSetup | string): ScheduleResult {
  if (!['install', 'uninstall', 'status', 'print'].includes(action)) return { ok: false, text: SCHEDULE_USAGE }
  if (scheduler === null) return { ok: false, text: 'There is no scheduler for this platform (launchd on macOS and systemd on Linux are supported)' }
  if (typeof setup === 'string') return { ok: false, text: setup }
  if (action === 'print') return { ok: true, text: scheduler.files(ALERTS_JOB, setup).map((file) => `# ${file.path}\n${file.content}`).join('\n') }
  if (action === 'status') return { ok: true, text: scheduler.status(ALERTS_JOB, setup) }
  return { ok: true, text: action === 'install' ? scheduler.install(ALERTS_JOB, setup) : scheduler.uninstall(ALERTS_JOB, setup) }
}
