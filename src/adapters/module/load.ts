import { realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AdapterModuleConfig } from '../../adapter-module.ts'
import { assertItemRefs } from '../../board/item-ref.ts'
import type { Config } from '../../config.ts'
import { expandHome } from '../../paths.ts'
import type { Ports } from '../../ports/index.ts'

/** The version of this contract between the harness and a board module. A module exports the same number as `portsVersion`. */
export const PORTS_VERSION = 1

/** The ports a module may provide. What it leaves out stays GitHub. */
export type ModulePorts = Partial<Pick<Ports, 'board' | 'writer' | 'actions' | 'issues' | 'code'>>

/** The functions each port must have, so a module that forgot one fails when loaded and not at the first call that needs it. */
const REQUIRED: Readonly<Record<keyof ModulePorts, readonly string[]>> = {
  board: ['fetchSnapshot', 'statusEvents'],
  writer: ['assign', 'setStatus', 'setReason', 'addToBoard', 'setTeam', 'writeOverrun'],
  actions: ['actionsOf', 'shellPatterns'],
  issues: ['comments', 'openIssues', 'read', 'writeBody', 'addComment'],
  code: ['openPullRequests', 'referencedIssues', 'prepareBranch', 'activity'],
}

/**
 * A module is code that runs here with this process's privileges, so it has to be a regular file of the user that runs the harness, and not
 * writable by the group or by others (anyone who could write it could run code as the user).
 */
export function assertTrustedFile(path: string): string {
  const real = (() => {
    try {
      return realpathSync(path)
    } catch {
      throw new Error(`the board module does not exist: ${path}`)
    }
  })()
  const stat = statSync(real)
  if (!stat.isFile()) throw new Error(`the board module is not a regular file: ${real}`)
  if (process.getuid !== undefined && stat.uid !== process.getuid()) throw new Error(`the board module is not owned by the user that runs the harness: ${real}`)
  if ((stat.mode & 0o022) !== 0) throw new Error(`the board module can be written by the group or by others (mode ${(stat.mode & 0o777).toString(8)}): ${real}`)
  return real
}

type Exported = { readonly portsVersion?: unknown; readonly createPorts?: unknown; readonly default?: unknown }

function factoryOf(exported: Exported, path: string): (config: Config, options: Readonly<Record<string, unknown>>) => unknown {
  if (exported.portsVersion !== PORTS_VERSION) {
    throw new Error(`the board module ${path} must export portsVersion = ${PORTS_VERSION} (it exports ${JSON.stringify(exported.portsVersion)})`)
  }
  const factory = typeof exported.createPorts === 'function' ? exported.createPorts : exported.default
  if (typeof factory !== 'function') throw new Error(`the board module ${path} must export a function createPorts(config, options)`)
  return factory as (config: Config, options: Readonly<Record<string, unknown>>) => unknown
}

/** Checks what a module returned: known ports only, each with its functions. Throws, naming the problem. */
export function checkModulePorts(returned: unknown, path: string): ModulePorts {
  if (typeof returned !== 'object' || returned === null || Array.isArray(returned)) throw new Error(`the board module ${path} must return an object of ports`)
  const unknown = Object.keys(returned).filter((key) => !(key in REQUIRED))
  if (unknown.length > 0) throw new Error(`the board module ${path} returned ports that do not exist: ${unknown.join(', ')} (known: ${Object.keys(REQUIRED).join(', ')})`)
  for (const [port, names] of Object.entries(REQUIRED)) {
    const value = (returned as Record<string, unknown>)[port]
    if (value === undefined) continue
    const missing = names.filter((name) => typeof (value as Record<string, unknown> | null)?.[name] !== 'function')
    if (missing.length > 0) throw new Error(`the board module ${path} returned a ${port} without: ${missing.join(', ')}`)
  }
  return returned as ModulePorts
}

/** The board's snapshot with the check that every item can be judged: a module whose item does not fit the reference rule fails at the read, with the item named. */
function withCheckedRefs(ports: ModulePorts): ModulePorts {
  const board = ports.board
  if (board === undefined) return ports
  return { ...ports, board: { ...board, fetchSnapshot: (now) => { const snapshot = board.fetchSnapshot(now); assertItemRefs(snapshot); return snapshot } } }
}

/**
 * Loads the module and returns the ports it provides, as they are (the reference rule is not applied). Throws, with a message that says what to fix,
 * when the module cannot be trusted, loaded, or used.
 */
export function loadRawModulePorts(spec: AdapterModuleConfig, config: Config): ModulePorts {
  const path = assertTrustedFile(expandHome(spec.module))
  let exported: Exported
  try {
    exported = createRequire(import.meta.url)(path) as Exported
  } catch (error) {
    throw new Error(`the board module ${path} could not be loaded: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`)
  }
  const returned = factoryOf(exported, path)(structuredClone(config), structuredClone(spec.options))
  return checkModulePorts(returned, path)
}

/**
 * Loads the board module the configuration names. It is loaded synchronously (a module is ES modules code, read with `require`), so building the ports
 * stays synchronous. Items it returns are checked against the reference rule at every read.
 */
export function loadModulePorts(spec: AdapterModuleConfig, config: Config): ModulePorts {
  return withCheckedRefs(loadRawModulePorts(spec, config))
}
