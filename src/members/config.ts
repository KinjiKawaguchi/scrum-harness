/**
 * How a team's members are started and found: the one place that says where each runs. Names, directories, and models are values of a team, so they
 * live only in the configuration file.
 */
export type Product = 'claude-code'
export type Permissions = 'ask' | 'skip'

export type MemberSpec = {
  /** The working directory: an absolute path, or one under `~/` */
  readonly dir?: string
  /** A file holding the first message the member is started with */
  readonly brief?: string
  readonly product?: Product
  readonly model?: string
  readonly effort?: string
  /** `skip` starts the member without permission prompts; it is never a default and has to be written next to the member */
  readonly permissions?: Permissions
  /** The Claude Code configuration directory (`CLAUDE_CONFIG_DIR`) the member runs under, for a team that uses more than one subscription */
  readonly configDir?: string
}

export type LaunchConfig = {
  /** The tmux session the members' windows are in */
  readonly tmuxSession: string
  /** What a member that does not say otherwise gets */
  readonly defaults: MemberSpec
  readonly members: Readonly<Record<string, MemberSpec>>
  /** Windows of the session that are not members (for example a shell), left out of the drift report */
  readonly ignoreWindows: readonly string[]
}

const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/
const SETTING = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const PRODUCTS: readonly Product[] = ['claude-code']
const PERMISSIONS: readonly Permissions[] = ['ask', 'skip']
const KEYS = ['dir', 'brief', 'product', 'model', 'effort', 'permissions', 'configDir'] as const

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isPath = (value: unknown): value is string => typeof value === 'string' && (value.startsWith('/') || value.startsWith('~/')) && value.length > 1
const isSetting = (value: unknown): value is string => typeof value === 'string' && SETTING.test(value)

/** One member's settings, or null when a value is of the wrong shape or a key is not known (a misspelled key would otherwise be ignored). */
function parseSpec(raw: unknown): MemberSpec | null {
  if (!isObject(raw) || Object.keys(raw).some((key) => !(KEYS as readonly string[]).includes(key))) return null
  const { dir, brief, product, model, effort, permissions, configDir } = raw
  const isValid =
    (dir === undefined || isPath(dir)) &&
    (configDir === undefined || isPath(configDir)) &&
    (brief === undefined || isPath(brief)) &&
    (product === undefined || PRODUCTS.includes(product as Product)) &&
    (model === undefined || isSetting(model)) &&
    (effort === undefined || isSetting(effort)) &&
    (permissions === undefined || PERMISSIONS.includes(permissions as Permissions))
  if (!isValid) return null
  return { ...(dir === undefined ? {} : { dir }), ...(brief === undefined ? {} : { brief }), ...(product === undefined ? {} : { product: product as Product }), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }), ...(permissions === undefined ? {} : { permissions: permissions as Permissions }), ...(configDir === undefined ? {} : { configDir }) }
}

/** Reads the `launch` section. A section of the wrong shape is ignored (undefined), so the other features keep working. */
export function parseLaunch(raw: unknown): LaunchConfig | undefined {
  if (!isObject(raw)) return undefined
  const { tmuxSession, defaults, members, ignoreWindows } = raw
  if (typeof tmuxSession !== 'string' || !WORD.test(tmuxSession)) return undefined
  if (!isObject(members) || !Object.keys(members).every((name) => NAME.test(name))) return undefined
  const parsedDefaults = defaults === undefined ? {} : parseSpec(defaults)
  const parsedMembers = Object.entries(members).map(([name, spec]) => [name, parseSpec(spec)] as const)
  if (parsedDefaults === null || parsedMembers.some(([, spec]) => spec === null)) return undefined
  if (ignoreWindows !== undefined && !(Array.isArray(ignoreWindows) && ignoreWindows.every((one) => typeof one === 'string'))) return undefined
  return {
    tmuxSession,
    defaults: parsedDefaults,
    members: Object.fromEntries(parsedMembers.map(([name, spec]) => [name, spec as MemberSpec])),
    ignoreWindows: (ignoreWindows as readonly string[] | undefined) ?? [],
  }
}
