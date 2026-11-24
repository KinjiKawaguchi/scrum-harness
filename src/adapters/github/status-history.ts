import { label } from '../../board/rules.ts'
import type { BoardItem } from '../../board/types.ts'
import { shortRepo, type Config } from '../../config.ts'
import type { GhRun } from './gh.ts'
import type { StatusEvent } from '../../sprint/effort.ts'

/** 1つの issue で読む Status の変化の数。作業中を何度も出入りしても、これだけあれば足りる。 */
const EVENTS_PER_ISSUE = 50

/** Status の変化を読む issue。repo はリポジトリの full の名前 (owner/name) で、ボードの項目が持っているものをそのまま使う。 */
export type HistoryTarget = { readonly repo: string; readonly number: number }

type Group = { readonly alias: string; readonly repo: string; readonly numbers: readonly number[] }

/**
 * リポジトリごとに、issue の番号をまとめる。リポジトリは項目の repo をそのまま使う。ラベル (`app#5`) の短い名前から引き直すと、
 * 設定の repos に無いリポジトリ (別のリポジトリの issue をボードに足したとき) を、defaultRepo の同じ番号 (別の issue や PR) と取り違える。
 */
function groupByRepo(targets: readonly HistoryTarget[]): readonly Group[] {
  const byRepo = targets.reduce<ReadonlyMap<string, readonly number[]>>(
    (acc, target) => new Map([...acc, [target.repo, [...(acc.get(target.repo) ?? []), target.number]]]),
    new Map(),
  )
  return [...byRepo].map(([repo, numbers], index) => ({ alias: `r${index}`, repo, numbers }))
}

/** 作業中の issue の Status の変化を、リポジトリごとにまとめて1回で問い合わせる。 */
export function statusHistoryQuery(targets: readonly HistoryTarget[]): string {
  const parts = groupByRepo(targets).map((group) => {
    const [owner, name] = group.repo.split('/')
    const issues = group.numbers.map(
      (number) =>
        `i${number}: issue(number:${number}){ timelineItems(itemTypes:[PROJECT_V2_ITEM_STATUS_CHANGED_EVENT], last:${EVENTS_PER_ISSUE}){ nodes{ ... on ProjectV2ItemStatusChangedEvent{ createdAt status project{ id } } } } }`,
    )
    return `${group.alias}: repository(owner:"${owner}", name:"${name}"){ ${issues.join(' ')} }`
  })
  return `query{ ${parts.join(' ')} }`
}

type RawEvent = { readonly createdAt?: string; readonly status?: string | null; readonly project?: { readonly id?: string } | null }
type RawResponse = { readonly data?: Record<string, Record<string, { readonly timelineItems?: { readonly nodes?: readonly RawEvent[] } } | null> | null> }

/**
 * 問い合わせの結果から、このボードの Status の変化だけをラベルごとに取り出す。
 * 読めなかった issue (結果が null) は入れない。入れると、記録が無いのではなく「作業中の期間が 0」と読まれ、手間が 0 になる。
 */
export function parseStatusHistory(response: RawResponse, targets: readonly HistoryTarget[], config: Config): ReadonlyMap<string, readonly StatusEvent[]> {
  const entries = groupByRepo(targets).flatMap((group) =>
    group.numbers.flatMap((number): [string, readonly StatusEvent[]][] => {
      const node = response.data?.[group.alias]?.[`i${number}`]
      if (node === null || node === undefined) return []
      const events = (node.timelineItems?.nodes ?? [])
        .filter((one) => one.project?.id === config.projectId && typeof one.createdAt === 'string')
        .map((one) => ({ at: one.createdAt ?? '', status: one.status ?? null }))
      return [[`${shortRepo(group.repo)}#${number}`, events]]
    }),
  )
  return new Map(entries)
}

/**
 * gh の問い合わせの答え。GraphQL は、一部の issue が読めない (番号が PR、消えた issue) と、ほかの結果を持ったまま
 * 終了コードが 1 になり、gh が例外を投げる。例外の標準出力に、読めた分が残るので、それを使う (1 つの issue の失敗で、全員の手間を捨てない)。
 */
function readHistory(run: GhRun, query: string): RawResponse | null {
  try {
    return JSON.parse(run(['api', 'graphql', '-f', `query=${query}`])) as RawResponse
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout
    if (typeof stdout !== 'string') return null
    try {
      const partial = JSON.parse(stdout) as RawResponse
      return partial.data === undefined || partial.data === null ? null : partial
    } catch {
      return null
    }
  }
}

/** 指定した issue の Status の変化を、ラベルごとに読む。読めなければ null (記録が無いのと「期間が 0」を取り違えない)。 */
export function statusEventsFor(items: readonly BoardItem[], config: Config, run: GhRun): ReadonlyMap<string, readonly StatusEvent[]> | null {
  const targets = items.flatMap((item): HistoryTarget[] => (item.kind === 'issue' && item.number !== null ? [{ repo: item.repo, number: item.number }] : []))
  if (targets.length === 0) return new Map()
  const response = readHistory(run, statusHistoryQuery(targets))
  return response === null ? null : parseStatusHistory(response, targets, config)
}

const isDoing = (item: BoardItem, config: Config): boolean =>
  item.kind === 'issue' && item.state === 'OPEN' && item.status === config.statuses.doing && item.number !== null

/**
 * sprint の設定があれば、作業中の issue に Status の変化の記録を足す。取れなければ足さない
 * (手間が分からないだけで、ほかの指摘は出せるので、取得全体は失敗にしない)。
 */
export function withStatusHistory(items: readonly BoardItem[], config: Config, run: GhRun): readonly BoardItem[] {
  if (config.sprint === undefined) return items
  const doing = items.filter((item) => isDoing(item, config))
  if (doing.length === 0) return items
  const history = statusEventsFor(doing, config, run)
  if (history === null) return items
  return items.map((item) => {
    const events = history.get(label(item))
    return events === undefined ? item : { ...item, statusEvents: events }
  })
}
