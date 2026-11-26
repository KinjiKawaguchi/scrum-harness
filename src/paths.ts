import { homedir } from 'node:os'
import { join } from 'node:path'

/** A path as written in the configuration: absolute, or under the home directory (`~/...`). A relative one would mean a different place in every process. */
export const isConfigPath = (value: unknown): value is string => typeof value === 'string' && (value.startsWith('/') || value.startsWith('~/')) && value.length > 1

export function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}
