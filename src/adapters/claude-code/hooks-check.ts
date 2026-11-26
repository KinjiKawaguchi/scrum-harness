import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MARKER } from '../../install.ts'

/** Whether the harness's hooks are in the `settings.json` of a Claude Code configuration directory. A file that is missing or unreadable has none. */
export function claudeHooksInstalled(configDir: string): boolean {
  const file = join(configDir, 'settings.json')
  if (!existsSync(file)) return false
  try {
    const { hooks } = JSON.parse(readFileSync(file, 'utf8')) as { hooks?: Record<string, readonly { hooks?: readonly { command?: string }[] }[]> }
    return Object.values(hooks ?? {}).some((groups) => groups.some((group) => (group.hooks ?? []).some((hook) => hook.command?.includes(MARKER) === true)))
  } catch {
    return false
  }
}
