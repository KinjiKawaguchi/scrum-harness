import { join } from 'node:path'
import { claudeTranscriptIn } from './adapters/claude-code/transcript-in.ts'
import { claudeHooksInstalled } from './adapters/claude-code/hooks-check.ts'
import { claudeConfigDirs, projectsDirs, sessionsDirs } from './adapters/claude-code/config-dirs.ts'
import { settingsTargets as claudeSettingsTargets } from './adapters/claude-code/settings-targets.ts'
import { claudeCodeSessions } from './adapters/claude-code/sessions.ts'
import { claudeCodeTranscripts } from './adapters/claude-code/transcripts.ts'
import { githubPorts } from './adapters/github/index.ts'
import { claudeCodeLauncher } from './adapters/claude-code/launch.ts'
import { codexLauncher } from './adapters/codex/launch.ts'
import { agencyBudgetReader } from './adapters/agency/budget.ts'
import { agencyFundingLister, agencyFundingPicker } from './adapters/agency/funding.ts'
import { codexTranscripts } from './adapters/codex/transcripts.ts'
import { composeTranscripts } from './adapters/compose-transcripts.ts'
import { commandPorts } from './adapters/command/ports.ts'
import { checkBoardModule } from './adapters/module/check.ts'
import { loadModulePorts, type ModulePorts } from './adapters/module/load.ts'
import { isCommandConfig, type AdaptersConfig } from './adapter-module.ts'
import { tmuxHost } from './adapters/tmux/host.ts'
import { linuxNotifier } from './adapters/linux/notify.ts'
import { realRun } from './adapters/run.ts'
import { systemdScheduler } from './adapters/linux/systemd.ts'
import { launchdScheduler } from './adapters/macos/launchd.ts'
import { macosNotify } from './adapters/macos/notify.ts'
import type { Flags } from './cli-commands.ts'
import { stateDir, type Config } from './config.ts'
import { readFundingDirs, type FundingDirs } from './members/funding-dirs.ts'
import { expandHome } from './paths.ts'
import { paths } from './store.ts'
import type { Notifier, Ports, Scheduler } from './ports/index.ts'

/** The login directories of the node's funding sources, as of the last time the node was asked (empty without a funding command). */
function fundingDirsOf(config: Config): FundingDirs {
  return config.launch?.funding === undefined ? { at: '', claude: [], codex: [] } : readFundingDirs(paths(stateDir()).fundingDirs)
}

/** The Claude Code configuration directories to read: the configured ones, and those of the funding sources. */
const claudeDirsOf = (config: Config): readonly string[] => [...new Set([...claudeConfigDirs(config.claudeConfigDirs), ...fundingDirsOf(config).claude.map(expandHome)])]

/** The settings files `scrum install` writes the hooks into (Claude Code's); `--all` includes the funding sources' directories. */
export function settingsTargets(flags: Flags, config: Config | null): readonly string[] | string {
  return claudeSettingsTargets(flags, config === null ? null : { ...config, claudeConfigDirs: claudeDirsOf(config) })
}

export { checkBoardModule }

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
/** The ports of the board module or the tracker program the configuration names. */
function adapterPorts(spec: AdaptersConfig, config: Config): ModulePorts {
  return isCommandConfig(spec) ? commandPorts(spec, config) : loadModulePorts(spec, config)
}

export function buildPorts(config: Config): Ports {
  const dirs = claudeDirsOf(config)
  const codexHomes = [...new Set([undefined, ...fundingDirsOf(config).codex.map(expandHome)])]
  // A board module, when the configuration names one, replaces the GitHub adapters it provides; the rest stays GitHub. A module that cannot be loaded throws: reading GitHub instead would read the wrong system.
  const board = { ...githubPorts(config), ...(config.adapters === undefined ? {} : adapterPorts(config.adapters, config)) }
  return { ...board, sessions: claudeCodeSessions(sessionsDirs(dirs)), transcripts: composeTranscripts([claudeCodeTranscripts(projectsDirs(dirs), sessionsDirs(dirs)), ...codexHomes.map((home) => codexTranscripts(home))]), members: tmuxHost(), hasHooksIn: claudeHooksInstalled, hasTranscriptIn: claudeTranscriptIn, funding: config.launch?.funding === undefined ? null : agencyFundingPicker(config.launch.funding), budget: config.launch?.budget === undefined ? null : agencyBudgetReader(config.launch.budget), fundingSources: config.launch?.funding === undefined ? null : agencyFundingLister(config.launch.funding), launchers: { 'claude-code': claudeCodeLauncher, codex: codexLauncher }, notify: buildNotifier() }
}
