import type { BudgetConfig } from '../budget/config.ts'
import { parseBudget } from '../budget/config.ts'

/**
 * How a team's members are started and found: the one place that says where each runs. Names, directories, and models are values of a team, so they
 * live only in the configuration file.
 */
export type Product = 'claude-code' | 'codex'
export type Permissions = 'ask' | 'skip'
export type Sandbox = 'read-only' | 'workspace-write' | 'danger-full-access'

/** What a Codex member is told when it has been idle too long. */
export type Continuation = { readonly text: string; readonly afterMinutes: number; readonly tell?: string }

export type MemberSpec = {
  /** The working directory: an absolute path, or one under `~/` */
  readonly dir?: string
  /** A file holding the first message the member is started with */
  readonly brief?: string
  readonly product?: Product
  readonly model?: string
  /** The model this member starts on while the team's weekly budget is at `warning`; replaces `launch.budget.warningModel` of its product */
  readonly warningModel?: string
  readonly effort?: string
  /** `skip` starts the member without permission prompts; it is never a default and has to be written next to the member */
  readonly permissions?: Permissions
  /** Codex only: how much the member's commands may touch (`-s`). Left to the user's Codex configuration when absent */
  readonly sandbox?: Sandbox
  /**
   * The startup watchdog: after the member is started it has this many seconds (5 to 600) to show a sign of life (a hook heartbeat or a live session record).
   * If it does not, its window is closed and it is started again, `startupRetries` more times (0 to 5, default 2), and then it is reported as a finding.
   * Off unless set, except for a Codex member (60 seconds), since a session started alone has been seen to hang before its first hook.
   */
  readonly startupSeconds?: number
  /**
   * Codex asks "Do you trust the contents of this directory?" the first time it runs in one, and Claude Code asks "Quick safety check: Is this a project you
   * created or one you trust?" the first time a login runs in a folder; each waits for an answer that no one is there to give.
   * With `trustDirectory: true` the harness answers Yes for the member's own working directory, which the owner chose by configuring the member (and
   * for Claude Code only the plain question: one that says the folder brings hooks or servers that run code is left to a person). The member is then watched
   * at its start (60 seconds, unless `startupSeconds` is set) so that there is someone to answer.
   * Trusting a directory lets the product load its project-local config, hooks, and exec policies, so it is never a default.
   */
  readonly trustDirectory?: boolean
  /**
   * Codex ends its turn and waits for a next message that no one sends, for example after saying "continuing...". For a Codex member with `continuation`,
   * the harness types `text` into its window once it has been idle at its prompt for `afterMinutes` (default 10), at most once for each stretch of
   * idleness, and not while an acknowledgement of its idleness is in force. `tell` (`<tmux session>:<window>`) is a window the notice that it did so is
   * typed into, besides the line `scrum refresh` prints and the event log. Claude Code members are not given this: they go on by themselves.
   */
  readonly continuation?: Continuation
  readonly startupRetries?: number
  /** The Claude Code configuration directory (`CLAUDE_CONFIG_DIR`) the member runs under, for a team that uses more than one subscription */
  readonly configDir?: string
}

/**
 * The funding command: the node's `agency funding` (a program and its first arguments). At the start of a member the harness runs `<command> pick --tool
 * <claude|codex> [--dir <dir>]`, which answers the account the session should run under; see `docs/agency-runtime.md`.
 */
export type FundingConfig = {
  /** An absolute path (or one under `~/`), then the arguments that come before `pick` */
  readonly command: readonly string[]
  /** The node's data directory, when it is not the default */
  readonly dir?: string
  /** `scrum refresh` moves one member that runs on a source past its threshold, at most every 30 minutes (see move.ts). Off unless true */
  readonly autoMove?: boolean
}

export type LaunchConfig = {
  /** The team's weekly budget is asked of the node: a cheaper model at `warning`, no new work at `over`. Off when absent */
  readonly budget?: BudgetConfig
  /** Which account a member's session runs under is asked of the node at each start. Off when absent */
  readonly funding?: FundingConfig
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
const PRODUCTS: readonly Product[] = ['claude-code', 'codex']
const SANDBOXES: readonly Sandbox[] = ['read-only', 'workspace-write', 'danger-full-access']
const PERMISSIONS: readonly Permissions[] = ['ask', 'skip']
const KEYS = ['dir', 'brief', 'product', 'model', 'effort', 'permissions', 'sandbox', 'configDir', 'startupSeconds', 'startupRetries', 'trustDirectory', 'warningModel', 'continuation'] as const

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export const isPath = (value: unknown): value is string => typeof value === 'string' && (value.startsWith('/') || value.startsWith('~/')) && value.length > 1
const isWhole = (value: unknown, min: number, max: number): boolean => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
export const isSetting = (value: unknown): value is string => typeof value === 'string' && SETTING.test(value)

const WINDOW_TARGET = /^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9 ._-]*$/
/** The default time a Codex member may sit idle before it is told to go on. */
export const DEFAULT_CONTINUE_MINUTES = 10

/** A `continuation` setting, or null when it is of the wrong shape: a one-line `text` of up to 1000 characters, `afterMinutes` 1 to 1440, `tell` as `session:window`. */
function parseContinuation(raw: unknown): Continuation | null {
  if (!isObject(raw) || Object.keys(raw).some((key) => key !== 'text' && key !== 'afterMinutes' && key !== 'tell')) return null
  const { text, afterMinutes, tell } = raw
  const isText = typeof text === 'string' && text.trim() !== '' && text.length <= 1000 && !/[\u0000-\u001f\u007f]/.test(text)
  if (!isText || !(afterMinutes === undefined || isWhole(afterMinutes, 1, 1440)) || !(tell === undefined || (typeof tell === 'string' && WINDOW_TARGET.test(tell)))) return null
  return { text: text.trim(), afterMinutes: (afterMinutes as number | undefined) ?? DEFAULT_CONTINUE_MINUTES, ...(tell === undefined ? {} : { tell: tell as string }) }
}

/** One member's settings, or null when a value is of the wrong shape or a key is not known (a misspelled key would otherwise be ignored). */
function parseSpec(raw: unknown): MemberSpec | null {
  if (!isObject(raw) || Object.keys(raw).some((key) => !(KEYS as readonly string[]).includes(key))) return null
  const { dir, brief, product, model, effort, permissions, sandbox, configDir, startupSeconds, startupRetries, trustDirectory, warningModel, continuation } = raw
  const parsedContinuation = continuation === undefined ? undefined : parseContinuation(continuation)
  const isValid =
    (continuation === undefined || (parsedContinuation !== null && product === 'codex')) &&
    (dir === undefined || isPath(dir)) &&
    (configDir === undefined || isPath(configDir)) &&
    (brief === undefined || isPath(brief)) &&
    (product === undefined || PRODUCTS.includes(product as Product)) &&
    (model === undefined || isSetting(model)) &&
    (warningModel === undefined || isSetting(warningModel)) &&
    (effort === undefined || isSetting(effort)) &&
    (permissions === undefined || PERMISSIONS.includes(permissions as Permissions)) &&
    (sandbox === undefined || SANDBOXES.includes(sandbox as Sandbox)) &&
    (startupSeconds === undefined || isWhole(startupSeconds, 5, 600)) &&
    (startupRetries === undefined || isWhole(startupRetries, 0, 5)) &&
    (trustDirectory === undefined || typeof trustDirectory === 'boolean')
  if (!isValid) return null
  return { ...(dir === undefined ? {} : { dir }), ...(brief === undefined ? {} : { brief }), ...(product === undefined ? {} : { product: product as Product }), ...(model === undefined ? {} : { model }), ...(warningModel === undefined ? {} : { warningModel }), ...(effort === undefined ? {} : { effort }), ...(permissions === undefined ? {} : { permissions: permissions as Permissions }), ...(sandbox === undefined ? {} : { sandbox: sandbox as Sandbox }), ...(configDir === undefined ? {} : { configDir }), ...(startupSeconds === undefined ? {} : { startupSeconds: startupSeconds as number }), ...(startupRetries === undefined ? {} : { startupRetries: startupRetries as number }), ...(trustDirectory === undefined ? {} : { trustDirectory: trustDirectory as boolean }), ...(parsedContinuation === undefined || parsedContinuation === null ? {} : { continuation: parsedContinuation }) }
}

function parseFunding(raw: unknown): FundingConfig | null {
  if (!isObject(raw) || Object.keys(raw).some((key) => key !== 'command' && key !== 'dir' && key !== 'autoMove')) return null
  const { command, dir, autoMove } = raw
  if (!Array.isArray(command) || command.length === 0 || !command.every((word) => typeof word === 'string' && word !== '') || !isPath(command[0])) return null
  if (dir !== undefined && !isPath(dir)) return null
  if (autoMove !== undefined && typeof autoMove !== 'boolean') return null
  return { command: command as readonly string[], ...(dir === undefined ? {} : { dir }), ...(autoMove === undefined ? {} : { autoMove }) }
}

/** Reads the `launch` section. A section of the wrong shape is ignored (undefined), so the other features keep working. */
export function parseLaunch(raw: unknown): LaunchConfig | undefined {
  if (!isObject(raw)) return undefined
  const { tmuxSession, defaults, members, ignoreWindows, funding, budget } = raw
  if (typeof tmuxSession !== 'string' || !WORD.test(tmuxSession)) return undefined
  if (!isObject(members) || !Object.keys(members).every((name) => NAME.test(name))) return undefined
  const parsedDefaults = defaults === undefined ? {} : parseSpec(defaults)
  const parsedMembers = Object.entries(members).map(([name, spec]) => [name, parseSpec(spec)] as const)
  if (parsedDefaults === null || parsedMembers.some(([, spec]) => spec === null)) return undefined
  if (ignoreWindows !== undefined && !(Array.isArray(ignoreWindows) && ignoreWindows.every((one) => typeof one === 'string'))) return undefined
  const parsedFunding = funding === undefined ? undefined : parseFunding(funding)
  if (parsedFunding === null) return undefined
  const parsedBudget = budget === undefined ? undefined : parseBudget(budget)
  if (parsedBudget === null) return undefined
  return {
    ...(parsedFunding === undefined ? {} : { funding: parsedFunding }),
    ...(parsedBudget === undefined ? {} : { budget: parsedBudget }),
    tmuxSession,
    defaults: parsedDefaults,
    members: Object.fromEntries(parsedMembers.map(([name, spec]) => [name, spec as MemberSpec])),
    ignoreWindows: (ignoreWindows as readonly string[] | undefined) ?? [],
  }
}
