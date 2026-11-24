import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** このハーネスのソースの置き場所。 */
export const SOURCE_DIR = fileURLToPath(new URL('.', import.meta.url))

function newestMtime(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((newest, entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return Math.max(newest, newestMtime(path))
    return entry.name.endsWith('.ts') ? Math.max(newest, statSync(path).mtimeMs) : newest
  }, 0)
}

/**
 * 起動した後にソースが変わったか。長く動く待機プロセスが古いコードのまま控えを書き換えないよう、
 * 変わっていたら終わらせ、次の Stop で新しいコードの待機プロセスを起動させる。
 */
export function hasCodeChanged(dir: string, startedAtMs: number): boolean {
  try {
    return newestMtime(dir) > startedAtMs
  } catch {
    return false
  }
}
