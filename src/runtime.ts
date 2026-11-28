import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Config } from './config.ts'
import type { HookDeps } from './hooks/handlers.ts'
import type { Ports } from './ports/index.ts'
import type { Paths } from './store.ts'
import type { Identity } from './team/identity.ts'

const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url))

/** Where the runtime server listens: next to the source it runs from (so a checkout has its own), unless `SCRUM_RUNTIME_SOCKET` says another place. */
export const runtimeSocketPath = (): string => process.env.SCRUM_RUNTIME_SOCKET ?? fileURLToPath(new URL('../.runtime.sock', import.meta.url))

/** The source tree the runtime server watches, to end when it changes. */
export const sourceRoot = (): string => fileURLToPath(new URL('.', import.meta.url))

/** Starts the board re-fetch in a separate process that does not make the hook wait. */
export function spawnRefresh(): void {
  const child = spawn(process.execPath, ['--no-warnings', CLI_PATH, 'refresh'], { detached: true, stdio: 'ignore' })
  child.unref()
}

/** Starts reading the agents' transcripts in a separate process that does not make the caller wait. */
export function spawnUsageIndex(): void {
  const child = spawn(process.execPath, ['--no-warnings', CLI_PATH, 'usage-index'], { detached: true, stdio: 'ignore' })
  child.unref()
}

/**
 * Moves a member that its source refused (a usage limit) to another login, in a process of its own: the move stops the member's session, and a process that
 * the session's hook started would be stopped with it. `detached` makes it a session of its own.
 */
export function spawnMoveRefused(name: string): void {
  const child = spawn(process.execPath, ['--no-warnings', CLI_PATH, 'member', 'move', name, '--refused'], { detached: true, stdio: 'ignore' })
  child.unref()
}

/** Starts the checkpoint recording in a separate process that does not make the hook wait. */
export function spawnCheckpoint(): void {
  const child = spawn(process.execPath, ['--no-warnings', CLI_PATH, 'checkpoint'], { detached: true, stdio: 'ignore' })
  child.unref()
}

export function hookDeps(p: Paths, config: Config, identity: Identity | null, now: Date, ports: Ports): HookDeps {
  return { p, config, now, identity, ports, spawnRefresh, spawnCheckpoint, spawnMoveRefused }
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
