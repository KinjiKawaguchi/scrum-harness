import { isConfigPath } from './paths.ts'

/**
 * The board side of a team that does not use the GitHub adapters, in one of two forms (exactly one of `module` and `command`). What it leaves out stays GitHub.
 * Both run with this process's privileges, so their paths come only from the configuration.
 */
export type AdapterModuleConfig = {
  /** A module, kept outside this repository, that provides the ports itself (`docs/board-module.md`). An absolute path, or one under `~/` */
  readonly module: string
  /** Passed to the module as is (JSON) */
  readonly options: Readonly<Record<string, unknown>>
}

/** What a tracker program can do besides reading the snapshot. A write the program does not list is not offered, and the harness never calls it. */
export const COMMAND_CAPABILITIES = ['write', 'add', 'team', 'comments'] as const
export type CommandCapability = (typeof COMMAND_CAPABILITIES)[number]

/** A program that speaks `scrum-board/1` (JSON on stdin and stdout), run for each call. The first word is an absolute path (or one under `~/`). */
export type AdapterCommandConfig = {
  readonly command: readonly string[]
  /** The things it can do besides `snapshot` and `statusEvents`: `write` (assign, Status, blocked reason, overrun), `add`, `team`, `comments` */
  readonly capabilities: readonly CommandCapability[]
  /** A call that takes longer is stopped */
  readonly timeoutSeconds: number
  readonly options: Readonly<Record<string, unknown>>
}

export type AdaptersConfig = AdapterModuleConfig | AdapterCommandConfig

export const isCommandConfig = (spec: AdaptersConfig): spec is AdapterCommandConfig => 'command' in spec

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 300

function parseCommand(raw: Record<string, unknown>): AdapterCommandConfig | null {
  const { command, capabilities, timeoutSeconds, options, ...rest } = raw
  if (Object.keys(rest).length > 0) return null
  if (!Array.isArray(command) || command.length === 0 || !command.every((word) => typeof word === 'string' && word !== '') || !isConfigPath(command[0])) return null
  const caps = capabilities ?? []
  if (!Array.isArray(caps) || !caps.every((one) => (COMMAND_CAPABILITIES as readonly unknown[]).includes(one))) return null
  const timeout = timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) return null
  if (options !== undefined && !isPlainObject(options)) return null
  return { command: command as readonly string[], capabilities: [...new Set(caps as readonly CommandCapability[])], timeoutSeconds: timeout, options: options ?? {} }
}

/** undefined when the section is absent, null when it is of the wrong shape. A wrong shape must not fall back to the GitHub adapters, which would read another system. */
export function parseAdapterModule(raw: unknown): AdaptersConfig | null | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) return null
  if ('module' in raw === 'command' in raw) return null
  if ('command' in raw) return parseCommand(raw)
  const { module, options, ...rest } = raw
  if (Object.keys(rest).length > 0 || !isConfigPath(module)) return null
  if (options !== undefined && !isPlainObject(options)) return null
  return { module, options: options ?? {} }
}
