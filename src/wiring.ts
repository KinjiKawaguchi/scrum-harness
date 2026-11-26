import { join } from 'node:path'
import { claudeConfigDirs, projectsDirs, sessionsDirs } from './adapters/claude-code/config-dirs.ts'
import { settingsTargets } from './adapters/claude-code/settings-targets.ts'
import { claudeCodeSessions } from './adapters/claude-code/sessions.ts'
import { claudeCodeTranscripts } from './adapters/claude-code/transcripts.ts'
import { githubPorts } from './adapters/github/index.ts'
import { linuxNotifier } from './adapters/linux/notify.ts'
import { realRun } from './adapters/run.ts'
import { systemdScheduler } from './adapters/linux/systemd.ts'
import { launchdScheduler } from './adapters/macos/launchd.ts'
import { macosNotify } from './adapters/macos/notify.ts'
import { stateDir, type Config } from './config.ts'
import type { Notifier, Ports, Scheduler } from './ports/index.ts'

/** The settings files `scrum install` writes the hooks into (Claude Code's). */
export { settingsTargets }

/** Notifies on macOS with a desktop notification. Everywhere else, with `notify-send` or a line in the state directory's log. */
export function buildNotifier(platform: NodeJS.Platform = process.platform, dir: string = stateDir()): Notifier {
  return platform === 'darwin' ? macosNotify : linuxNotifier(join(dir, 'log', 'notifications.log'))
}

/** The scheduler of this platform: launchd on macOS, systemd user units on Linux. Null elsewhere. */
export function buildScheduler(platform: NodeJS.Platform = process.platform): Scheduler | null {
  if (platform === 'darwin') return launchdScheduler()
  if (platform === 'linux') return systemdScheduler(realRun, process.env.XDG_CONFIG_HOME)
  return null
}

/**
 * Builds, from the config, the ports handed to the core. The core code does not import adapters and receives only what is built here.
 * The board and code are GitHub, sessions and transcripts are Claude Code, and notifications depend on the platform.
 */
export function buildPorts(config: Config): Ports {
  const dirs = claudeConfigDirs(config.claudeConfigDirs)
  return { ...githubPorts(config), sessions: claudeCodeSessions(sessionsDirs(dirs)), transcripts: claudeCodeTranscripts(projectsDirs(dirs), sessionsDirs(dirs)), notify: buildNotifier() }
}
