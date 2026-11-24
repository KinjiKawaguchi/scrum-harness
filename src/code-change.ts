import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where this harness's source is placed. */
export const SOURCE_DIR = fileURLToPath(new URL('.', import.meta.url))

function newestMtime(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((newest, entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return Math.max(newest, newestMtime(path))
    return entry.name.endsWith('.ts') ? Math.max(newest, statSync(path).mtimeMs) : newest
  }, 0)
}

/**
 * Whether the source changed since startup. So that a long-running watch process does not rewrite the board copy with stale code,
 * if it changed, it is ended, and the next Stop starts a watch process with the new code.
 */
export function hasCodeChanged(dir: string, startedAtMs: number): boolean {
  try {
    return newestMtime(dir) > startedAtMs
  } catch {
    return false
  }
}
