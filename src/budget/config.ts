import { isObject, isPath, isSetting, type Product } from '../members/config.ts'

/**
 * Where the team's weekly budget is asked: the node's `agency budget` (a program and its first arguments, then `status --org <org> --team <team>`). The cap
 * itself lives in the org definition; the harness holds no budget value, only the names that say which budget to ask for.
 */
export type BudgetConfig = {
  /** An absolute path (or one under `~/`), then the arguments that come before `status` */
  readonly command: readonly string[]
  readonly org: string
  readonly team: string
  /** The node's data directory, when it is not the default */
  readonly dir?: string
  /** The model new sessions start on while the budget is at `warning`, per product. A member's own `warningModel` replaces it */
  readonly warningModel?: Readonly<Partial<Record<Product, string>>>
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const KEYS = ['command', 'org', 'team', 'dir', 'warningModel']

function parseWarningModel(raw: unknown): Readonly<Partial<Record<Product, string>>> | null {
  if (!isObject(raw) || Object.keys(raw).some((key) => key !== 'claude-code' && key !== 'codex')) return null
  const models = Object.entries(raw)
  return models.every(([, model]) => isSetting(model)) ? (Object.fromEntries(models) as Partial<Record<Product, string>>) : null
}

/** Reads `launch.budget`; null when a value is of the wrong shape or a key is not known. */
export function parseBudget(raw: unknown): BudgetConfig | null {
  if (!isObject(raw) || Object.keys(raw).some((key) => !KEYS.includes(key))) return null
  const { command, org, team, dir, warningModel } = raw
  if (!Array.isArray(command) || command.length === 0 || !command.every((word) => typeof word === 'string' && word !== '') || !isPath(command[0])) return null
  if (typeof org !== 'string' || !ID.test(org) || typeof team !== 'string' || !ID.test(team)) return null
  if (dir !== undefined && !isPath(dir)) return null
  const models = warningModel === undefined ? undefined : parseWarningModel(warningModel)
  if (models === null) return null
  return { command: command as readonly string[], org, team, ...(dir === undefined ? {} : { dir }), ...(models === undefined ? {} : { warningModel: models }) }
}
