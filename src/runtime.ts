import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Config } from './config.ts'
import type { HookDeps } from './hooks/handlers.ts'
import type { Paths } from './store.ts'
import type { Identity } from './team/identity.ts'

const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url))

/** ボードの取り直しを、フックを待たせない別のプロセスで始める。 */
export function spawnRefresh(): void {
  const child = spawn(process.execPath, ['--no-warnings', CLI_PATH, 'refresh'], { detached: true, stdio: 'ignore' })
  child.unref()
}

/** 節目の記録を、フックを待たせない別のプロセスで始める。 */
export function spawnCheckpoint(): void {
  const child = spawn(process.execPath, ['--no-warnings', CLI_PATH, 'checkpoint'], { detached: true, stdio: 'ignore' })
  child.unref()
}

export function fetchPrBody(prLabel: string, repo: string): string | null {
  const number = prLabel.split('#')[1] ?? ''
  try {
    return execFileSync('gh', ['pr', 'view', number, '-R', repo, '--json', 'body', '--jq', '.body'], {
      encoding: 'utf8',
      timeout: 15_000,
    })
  } catch {
    return null
  }
}

export function hookDeps(p: Paths, config: Config, identity: Identity | null, now: Date): HookDeps {
  return { p, config, now, identity, fetchPrBody, spawnRefresh, spawnCheckpoint }
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export function parseInput(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
