import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseLinks, type LinksConfig } from './links/config.ts'
import { parseAlerts, type AlertsConfig } from './alerts/config.ts'
import { parseRuntime, type RuntimeConfig } from './agency-runtime/config.ts'
import { parseTeamScope, type TeamScope } from './board/team-scope.ts'
import { parseLaunch, type LaunchConfig } from './members/config.ts'
import { isConfigPath } from './paths.ts'
import { withConfigAliases } from './compat.ts'

export type StatusNames = {
  readonly backlog: string
  readonly next: string
  readonly doing: string
  readonly release: string
  readonly done: string
}

/** Values specific to the board and the team. Written only in the config file (~/.claude/scrum/config.json) and not held in the source. */
export type ProjectConfig = {
  readonly projectId: string
  readonly repos: readonly string[]
  /** The repository that the board-rewriting scripts (scripts) point at with only a number */
  readonly defaultRepo: string
  readonly fields: {
    readonly status: string
    readonly reason: string
    readonly since: string
    readonly owner: string
    readonly assignee: string
    /** The single-select field that says what kind of work an item is (New feature, Improvement, ...). Optional: when absent it is not read */
    readonly workType?: string
  }
  readonly statusFieldId: string
  readonly statuses: StatusNames
  readonly reasonNone: string
  readonly reasonJudge: string
  readonly ownerUser: string
  readonly excludeAuthors: readonly string[]
  readonly techlead: string
  readonly members: readonly string[]
}

/** The strength of the checks. It can be overridden in the config file. */
export type Tuning = {
  readonly wipLimit: number
  readonly staleBlockDays: number
  readonly idleMinutes: number
  readonly waitingMinutes: number
  readonly untrackedMinutes: number
  readonly refreshSeconds: number
  readonly isStopBlockEnabled: boolean
}

/**
 * Names of the scripts that rewrite the board. When set, the command is shown as how to fix a finding, and the hook reads their execution and
 * corrects the board copy. The shape of the arguments is fixed (see each item below). If absent, how to fix is given as text, and only gh commands are read.
 */
export type BoardScripts = {
  /** <number> <Status> */
  readonly setStatus?: string
  /** <number> <blocked reason> [YYYY-MM-DD] */
  readonly setReason?: string
  /** <number> <assignee> */
  readonly setAssignee?: string
  /** <Status> <repository name#number>... */
  readonly bulkStatus?: string
  /** <owner/repo> <PR number> */
  readonly mergePr?: string
  /** The word passed when unassigning */
  readonly clearValue?: string
}

/** Team-specific names and tools used in the text of findings and in how to fix them. */
export type Adapters = {
  /** The name used in text to refer to the person who makes decisions (ownerUser) */
  readonly ownerLabel: string
  readonly scripts: BoardScripts
}

/**
 * Sprint checkpoints and story points. If absent, this feature does not run.
 * Effort is counted as the number of checkpoints crossed while in In Progress (excluding checkpoints during a stall and checkpoints when all sessions were stalled),
 * and compared with the budget decided from the points.
 */
export type SprintConfig = {
  /** The times of day of the daily checkpoints ("HH:MM") */
  readonly checkpoints: readonly string[]
  /** The time zone offset of the checkpoint times ("+09:00") */
  readonly utcOffset: string
  /** The name of the Number field into which story points are put */
  readonly pointsField: string
  /** The name of the Number field into which the harness writes the number of exceeded checkpoints. If absent, it is not written to the board */
  readonly overrunField?: string
  /** The budget number of checkpoints per point. A point not among the keys is regarded as not being in the tiers */
  readonly pointBudgets: Readonly<Record<string, number>>
}

/**
 * Hands the next work to a free member without going through the LLM (rule A-DISPATCH). If absent or enabled is not true, it does not run.
 * It holds only the team-specific values used for the handover text and the selection conditions.
 */
export type DispatchConfig = {
  readonly enabled: boolean
  /** The handover text's "branch off origin/<this>" and "the PR targets <this>" */
  readonly baseBranch: string
  /** An issue with a label of this name is not handed over (the not-to-hand-over mark) */
  readonly skipLabels: readonly string[]
  /** The name of the Number field that decides the hand-over order (smaller comes first). If absent, items are not ordered by the field */
  readonly orderField?: string
  /** The time zone offset of the time in the acknowledgement reason "slot HH:MM" */
  readonly utcOffset: string
  /** The day's rules (one line each) added at the end of the handover text */
  readonly notes: readonly string[]
  /** The names of the members to hand over to automatically. If absent, everyone in the config's members */
  readonly members?: readonly string[]
  /** The directory where the scripts of scripts are. If absent, they are looked up from PATH by name as is */
  readonly scriptDir?: string
  /** On handover, creates a branch linked to the issue as `<this>/<number>` from the head of baseBranch. If absent, none is created */
  readonly linkedBranchPrefix?: string
}

export const DEFAULT_DISPATCH: DispatchConfig = { enabled: false, baseBranch: 'main', skipLabels: [], utcOffset: '+09:00', notes: [] }

export type Config = ProjectConfig &
  Tuning &
  Adapters & { readonly sprint?: SprintConfig; readonly dispatch?: DispatchConfig; readonly links?: LinksConfig; readonly alerts?: AlertsConfig; readonly runtime?: RuntimeConfig; readonly team?: TeamScope; readonly host?: string; readonly claudeConfigDirs?: readonly string[]; readonly launch?: LaunchConfig }

export function dispatchOf(config: Config): DispatchConfig {
  return config.dispatch ?? DEFAULT_DISPATCH
}

export const DEFAULT_ADAPTERS: Adapters = { ownerLabel: 'the owner', scripts: {} }

export const DEFAULT_TUNING: Tuning = {
  wipLimit: 10,
  staleBlockDays: 7,
  idleMinutes: 10,
  waitingMinutes: 5,
  untrackedMinutes: 30,
  refreshSeconds: 300,
  isStopBlockEnabled: true,
}

export function stateDir(): string {
  return process.env.SCRUM_STATE_DIR ?? join(homedir(), '.claude', 'scrum')
}

const REQUIRED_STRINGS = ['projectId', 'defaultRepo', 'statusFieldId', 'reasonNone', 'reasonJudge', 'ownerUser', 'techlead'] as const
const REQUIRED_LISTS = ['repos', 'excludeAuthors', 'members'] as const
const REQUIRED_OBJECTS = ['fields', 'statuses'] as const

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
const OFFSET = /^[+-]\d{2}:\d{2}$/

/** Validates the sprint config. If the shape differs, only this feature is stopped (undefined). */
function parseSprint(raw: unknown): SprintConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const { checkpoints, utcOffset, pointsField, overrunField, pointBudgets } = record
  const isValid =
    Array.isArray(checkpoints) &&
    checkpoints.length > 0 &&
    checkpoints.every((time) => typeof time === 'string' && CLOCK.test(time)) &&
    typeof utcOffset === 'string' &&
    OFFSET.test(utcOffset) &&
    typeof pointsField === 'string' &&
    (overrunField === undefined || typeof overrunField === 'string') &&
    typeof pointBudgets === 'object' &&
    pointBudgets !== null &&
    Object.values(pointBudgets).every((budget) => typeof budget === 'number')
  return isValid ? (record as SprintConfig) : undefined
}

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((one) => typeof one === 'string')

/** Reads the dispatch config. If the shape differs, only this feature is stopped (undefined). Missing items are filled with defaults. */
function parseDispatch(raw: unknown): DispatchConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { enabled, baseBranch, skipLabels, orderField, utcOffset, notes, members, scriptDir, linkedBranchPrefix } = raw as Record<string, unknown>
  const isValid =
    typeof enabled === 'boolean' &&
    (baseBranch === undefined || (typeof baseBranch === 'string' && baseBranch !== '')) &&
    (skipLabels === undefined || isStringList(skipLabels)) &&
    (orderField === undefined || typeof orderField === 'string') &&
    (utcOffset === undefined || (typeof utcOffset === 'string' && OFFSET.test(utcOffset))) &&
    (notes === undefined || isStringList(notes)) &&
    (members === undefined || isStringList(members)) &&
    (scriptDir === undefined || (typeof scriptDir === 'string' && scriptDir !== '')) &&
    (linkedBranchPrefix === undefined || (typeof linkedBranchPrefix === 'string' && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(linkedBranchPrefix)))
  if (!isValid) return undefined
  return {
    enabled,
    baseBranch: (baseBranch as string | undefined) ?? DEFAULT_DISPATCH.baseBranch,
    skipLabels: (skipLabels as readonly string[] | undefined) ?? DEFAULT_DISPATCH.skipLabels,
    ...(orderField === undefined ? {} : { orderField: orderField as string }),
    utcOffset: (utcOffset as string | undefined) ?? DEFAULT_DISPATCH.utcOffset,
    notes: (notes as readonly string[] | undefined) ?? DEFAULT_DISPATCH.notes,
    ...(members === undefined ? {} : { members: members as readonly string[] }),
    ...(scriptDir === undefined ? {} : { scriptDir: scriptDir as string }),
    ...(linkedBranchPrefix === undefined ? {} : { linkedBranchPrefix: linkedBranchPrefix as string }),
  }
}

/** The name of the work type field, when given, is text; it goes into a query. */
const isValidWorkTypeField = (fields: unknown): boolean => {
  const name = (fields as { readonly workType?: unknown }).workType
  return name === undefined || (typeof name === 'string' && name.trim() !== '')
}

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/

/** The GitHub host name for gh (GH_HOST). Absent is fine; a value that is not a host name is not used, because a call would then go to another host. */
export const isHostName = (value: unknown): value is string => typeof value === 'string' && HOST.test(value)

/** The Claude Code configuration directories, when given, are a non-empty list of absolute paths (or `~/...`); a relative one would mean a different place in every process. */
const isValidConfigDirs = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.length > 0 && value.every(isConfigPath))

/** The config file is a system boundary, so a missing value is not used. */
export function parseConfig(raw: unknown): Config | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = withConfigAliases(raw as Record<string, unknown>)
  const isValid =
    REQUIRED_STRINGS.every((key) => typeof record[key] === 'string') &&
    REQUIRED_LISTS.every((key) => Array.isArray(record[key])) &&
    REQUIRED_OBJECTS.every((key) => typeof record[key] === 'object' && record[key] !== null) &&
    isValidWorkTypeField(record.fields)
  if (!isValid || (record.host !== undefined && !isHostName(record.host)) || !isValidConfigDirs(record.claudeConfigDirs)) return null
  const { sprint: rawSprint, dispatch: rawDispatch, links: rawLinks, alerts: rawAlerts, runtime: rawRuntime, team: rawTeam, launch: rawLaunch, ...rest } = record
  const sprint = parseSprint(rawSprint)
  const dispatch = parseDispatch(rawDispatch)
  const links = parseLinks(rawLinks)
  const alerts = parseAlerts(rawAlerts)
  const runtime = parseRuntime(rawRuntime)
  const team = parseTeamScope(rawTeam)
  const launch = parseLaunch(rawLaunch)
  if (team === null) return null
  return {
    ...DEFAULT_TUNING,
    ...DEFAULT_ADAPTERS,
    ...rest,
    ...(sprint === undefined ? {} : { sprint }),
    ...(dispatch === undefined ? {} : { dispatch }),
    ...(links === undefined ? {} : { links }),
    ...(alerts === undefined ? {} : { alerts }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(team === undefined ? {} : { team }),
    ...(launch === undefined ? {} : { launch }),
  } as Config
}

export function configPath(dir: string = stateDir()): string {
  return join(dir, 'config.json')
}

/** null if the config is absent or broken. The hook finishes without doing anything. */
export function loadConfig(dir: string = stateDir()): Config | null {
  try {
    return parseConfig(JSON.parse(readFileSync(configPath(dir), 'utf8')))
  } catch {
    return null
  }
}

export function shortRepo(repo: string): string {
  return repo.split('/').pop() ?? repo
}
