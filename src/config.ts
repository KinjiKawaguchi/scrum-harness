import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseLinks, type LinksConfig } from './links/config.ts'
import { parseAlerts, type AlertsConfig } from './alerts/config.ts'

export type StatusNames = {
  readonly backlog: string
  readonly next: string
  readonly doing: string
  readonly release: string
  readonly done: string
}

/** ボードとチームに固有の値。設定ファイル (~/.claude/scrum/config.json) にだけ書き、ソースには持たない。 */
export type ProjectConfig = {
  readonly projectId: string
  readonly repos: readonly string[]
  /** ボードを書き換えるスクリプト (scripts) が番号だけで指すリポジトリ */
  readonly defaultRepo: string
  readonly fields: {
    readonly status: string
    readonly reason: string
    readonly since: string
    readonly owner: string
    readonly tanto: string
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

/** 検査の強さ。設定ファイルで上書きできる。 */
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
 * ボードを書き換えるスクリプトの名前。設定すると、指摘の直し方にそのコマンドを出し、フックがその実行を読んで
 * 控えを直す。引数の形は決まっている (下の各項目)。無ければ直し方は文で出し、gh のコマンドだけを読む。
 */
export type BoardScripts = {
  /** <番号> <Status> */
  readonly setStatus?: string
  /** <番号> <止まっている理由> [YYYY-MM-DD] */
  readonly setReason?: string
  /** <番号> <担当> */
  readonly setTanto?: string
  /** <Status> <リポジトリ名#番号>... */
  readonly bulkStatus?: string
  /** <owner/repo> <PR の番号> */
  readonly mergePr?: string
  /** 担当を外すときに渡す語 */
  readonly clearValue?: string
}

/** 指摘の文と直し方に使う、チームごとの呼び方と道具。 */
export type Adapters = {
  /** 判断を下す人 (ownerUser) を文で呼ぶときの名前 */
  readonly ownerLabel: string
  readonly scripts: BoardScripts
}

/**
 * スプリントの節目とストーリーポイント。無ければ、この機能は動かない。
 * 手間は、作業中にいた間にまたいだ節目の数 (止まっていた節目と、全セッションが止まっていた節目は除く) で数え、
 * ポイントから決めた目安と比べる。
 */
export type SprintConfig = {
  /** 1日の節目の時刻 ("HH:MM") */
  readonly checkpoints: readonly string[]
  /** 節目の時刻の時差 ("+09:00") */
  readonly utcOffset: string
  /** ストーリーポイントを入れる Number の欄の名前 */
  readonly pointsField: string
  /** 超えた節目の数をハーネスが書く Number の欄の名前。無ければボードには書かない */
  readonly overrunField?: string
  /** ポイントごとの目安の節目の数。キーにないポイントは段に無いとみなす */
  readonly pointBudgets: Readonly<Record<string, number>>
}

/**
 * 空いた部下に、LLM を通さず次の仕事を渡す (規則 A-DISPATCH)。無いか enabled が true でなければ、動かない。
 * 渡す文面と選ぶ条件に使う、チームごとの値だけを持つ。
 */
export type DispatchConfig = {
  readonly enabled: boolean
  /** 渡す文面の「origin/<これ> から切る」「PR は <これ> 宛て」 */
  readonly baseBranch: string
  /** この名前のラベルが付いた issue は渡さない (渡さない印) */
  readonly skipLabels: readonly string[]
  /** 渡す順を決める Number の欄の名前 (小さいほど先)。無ければ、欄の順では並べない */
  readonly orderField?: string
  /** 受け入れの理由「枠 HH:MM」の時刻の時差 */
  readonly utcOffset: string
  /** 渡す文面の最後に足す、その日の決まり (1 行ずつ) */
  readonly notes: readonly string[]
  /** 自動で渡す相手の名前。無ければ、設定の members の全員 */
  readonly members?: readonly string[]
  /** scripts のスクリプトがあるディレクトリ。無ければ、名前のまま PATH から探す */
  readonly scriptDir?: string
  /** 渡すときに、issue に紐づいたブランチを `<これ>/<番号>` で、baseBranch の先頭から作る。無ければ作らない */
  readonly linkedBranchPrefix?: string
}

export const DEFAULT_DISPATCH: DispatchConfig = { enabled: false, baseBranch: 'main', skipLabels: [], utcOffset: '+09:00', notes: [] }

export type Config = ProjectConfig &
  Tuning &
  Adapters & { readonly sprint?: SprintConfig; readonly dispatch?: DispatchConfig; readonly links?: LinksConfig; readonly alerts?: AlertsConfig }

export function dispatchOf(config: Config): DispatchConfig {
  return config.dispatch ?? DEFAULT_DISPATCH
}

export const DEFAULT_ADAPTERS: Adapters = { ownerLabel: 'オーナー', scripts: {} }

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

/** sprint の設定を確かめる。形が違えば、この機能だけを止める (undefined)。 */
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

/** dispatch の設定を読む。形が違えば、この機能だけを止める (undefined)。足りない項目は既定で埋める。 */
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

/** 設定ファイルはシステムの境界なので、欠けた値があれば使わない。 */
export function parseConfig(raw: unknown): Config | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const isValid =
    REQUIRED_STRINGS.every((key) => typeof record[key] === 'string') &&
    REQUIRED_LISTS.every((key) => Array.isArray(record[key])) &&
    REQUIRED_OBJECTS.every((key) => typeof record[key] === 'object' && record[key] !== null)
  if (!isValid) return null
  const { sprint: rawSprint, dispatch: rawDispatch, links: rawLinks, alerts: rawAlerts, ...rest } = record
  const sprint = parseSprint(rawSprint)
  const dispatch = parseDispatch(rawDispatch)
  const links = parseLinks(rawLinks)
  const alerts = parseAlerts(rawAlerts)
  return {
    ...DEFAULT_TUNING,
    ...DEFAULT_ADAPTERS,
    ...rest,
    ...(sprint === undefined ? {} : { sprint }),
    ...(dispatch === undefined ? {} : { dispatch }),
    ...(links === undefined ? {} : { links }),
    ...(alerts === undefined ? {} : { alerts }),
  } as Config
}

export function configPath(dir: string = stateDir()): string {
  return join(dir, 'config.json')
}

/** 設定が無いか壊れていれば null。フックは何もせずに終える。 */
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
