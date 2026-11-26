import { isConfigPath } from './paths.ts'

/**
 * A module, kept outside this repository, that provides the board side (`board`, `writer`, `actions`, `issues`, `code`) in place of the GitHub adapters.
 * What it leaves out stays GitHub. The module runs in this process with its privileges, so its path comes only from the configuration.
 */
export type AdapterModuleConfig = {
  /** An absolute path, or one under `~/` */
  readonly module: string
  /** Passed to the module as is (JSON) */
  readonly options: Readonly<Record<string, unknown>>
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** undefined when the section is absent, null when it is of the wrong shape. A wrong shape must not fall back to the GitHub adapters, which would read another system. */
export function parseAdapterModule(raw: unknown): AdapterModuleConfig | null | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) return null
  const { module, options, ...rest } = raw
  if (Object.keys(rest).length > 0 || !isConfigPath(module)) return null
  if (options !== undefined && !isPlainObject(options)) return null
  return { module, options: options ?? {} }
}
