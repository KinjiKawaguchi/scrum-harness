import type { Flags } from '../../cli-commands.ts'
import type { Config } from '../../config.ts'
import { expandHome, isConfigPath } from '../../paths.ts'
import { claudeConfigDirs, settingsPaths } from './config-dirs.ts'

/** The settings files `scrum install` writes: `--dir <configuration directory>`, `--all` for every directory in the configuration, otherwise `~/.claude` (SCRUM_SETTINGS replaces it). */
export function settingsTargets(flags: Flags, config: Config | null): readonly string[] | string {
  if (typeof flags.dir === 'string') return isConfigPath(flags.dir) ? settingsPaths([expandHome(flags.dir)], {}) : '--dir must be an absolute path, or one under ~/'
  if (flags.all === true) return config === null ? '--all reads the configured directories, and there is no configuration yet' : settingsPaths(claudeConfigDirs(config.claudeConfigDirs))
  return settingsPaths(claudeConfigDirs(undefined))
}
