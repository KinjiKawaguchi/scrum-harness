import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where Claude Code keeps its files when no configuration directory is set. */
const DEFAULT_DIR = '~/.claude'

/** A configuration directory as written in the configuration: an absolute path, or one under the home directory (`~/...`). */
export const isConfigDirPath = (value: unknown): value is string => typeof value === 'string' && (value.startsWith('/') || value.startsWith('~/')) && value.length > 1

export function expandHome(dir: string): string {
  return dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir
}

/** The Claude Code configuration directories (each `CLAUDE_CONFIG_DIR` a team's sessions may run under). `~/.claude` when none is configured. */
export function claudeConfigDirs(configured: readonly string[] | undefined): readonly string[] {
  return [...new Set((configured ?? [DEFAULT_DIR]).map(expandHome))]
}

type Env = Readonly<Record<string, string | undefined>>

/**
 * The folders of session records, of transcripts, and the settings files of the directories. SCRUM_SESSIONS_DIR, SCRUM_PROJECTS_DIR, and
 * SCRUM_SETTINGS each replace the whole list with that one place.
 */
export const sessionsDirs = (dirs: readonly string[], env: Env = process.env): readonly string[] => (env.SCRUM_SESSIONS_DIR === undefined ? dirs.map((dir) => join(dir, 'sessions')) : [env.SCRUM_SESSIONS_DIR])
export const projectsDirs = (dirs: readonly string[], env: Env = process.env): readonly string[] => (env.SCRUM_PROJECTS_DIR === undefined ? dirs.map((dir) => join(dir, 'projects')) : [env.SCRUM_PROJECTS_DIR])
export const settingsPaths = (dirs: readonly string[], env: Env = process.env): readonly string[] => (env.SCRUM_SETTINGS === undefined ? dirs.map((dir) => join(dir, 'settings.json')) : [env.SCRUM_SETTINGS])
