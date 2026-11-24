import { label } from '../board/rules.ts'
import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { appendLine, readText, type Paths } from '../store.ts'
import { assessItem } from './assess.ts'
import type { StatusEvent } from './effort.ts'
import type { BoardSource } from '../ports/index.ts'
import { loadCountingHistory, type CountingHistory } from './counting-history.ts'

/** 済んだ issue の、ポイントと実際にかかった節目 (止まっていた節目は除く)。1 件 1 行で p.completions に残す。 */
export type Completion = {
  readonly label: string
  readonly points: number | null
  readonly budget: number | null
  readonly effort: number | null
  /** 済んだのを見つけた時刻 (ISO 8601) */
  readonly detectedAt: string
  /** 済んだ Status (完了か、リリース待ち) */
  readonly status: string
  /** Status の変化の記録 (issue の timeline) から数えたか。読めずに、前の控えの記録で近似したときは false */
  readonly exact: boolean
}

const isFinished = (item: BoardItem, config: Config): boolean =>
  item.kind === 'issue' && item.number !== null && (item.status === config.statuses.done || item.status === config.statuses.release)

/** 前の控えで作業中だった issue が、今の控えで完了かリリース待ちになったもの (除く作者の issue は入れない)。 */
export function newlyFinished(previous: Snapshot | null, fresh: Snapshot, config: Config): readonly { readonly item: BoardItem; readonly before: BoardItem }[] {
  if (previous === null) return []
  const wasDoing = new Map(previous.items.filter((item) => item.kind === 'issue' && item.status === config.statuses.doing).map((item) => [label(item), item]))
  return fresh.items.flatMap((item) => {
    const before = wasDoing.get(label(item))
    return before !== undefined && isFinished(item, config) && !config.excludeAuthors.includes(item.author ?? '') ? [{ item, before }] : []
  })
}

/** timeline が読めなかったとき、前の控えの記録に、済んだ時刻の変化を足して近似する。 */
function approximateEvents(before: BoardItem, item: BoardItem, now: Date): readonly StatusEvent[] | undefined {
  return before.statusEvents === undefined ? undefined : [...before.statusEvents, { at: now.toISOString(), status: item.status }]
}

function toCompletion(
  pair: { readonly item: BoardItem; readonly before: BoardItem },
  statusHistory: ReadonlyMap<string, readonly StatusEvent[]> | null,
  countingHistory: CountingHistory,
  config: Config,
  now: Date,
): Completion {
  const { item, before } = pair
  const exactEvents = statusHistory?.get(label(item))
  const events = exactEvents ?? approximateEvents(before, item, now)
  const assessment = assessItem(events === undefined ? item : { ...item, statusEvents: events }, countingHistory, config, now)
  return {
    label: assessment.label,
    points: assessment.points,
    budget: assessment.budget,
    effort: assessment.effort,
    detectedAt: now.toISOString(),
    status: item.status ?? '',
    exact: exactEvents !== undefined,
  }
}

/**
 * 比べの元の控えを取ったより後に、すでに記録した issue。記録の途中で失敗して、比べの元を進めずにやり直すとき、
 * 記録できた分を重ねて残さない。
 */
function alreadyLogged(previous: Snapshot | null, completions: readonly Completion[]): ReadonlySet<string> {
  if (previous === null) return new Set()
  return new Set(completions.filter((one) => one.detectedAt > previous.fetchedAt).map((one) => one.label))
}

/**
 * 控えを取り直したとき、作業中から済み (完了かリリース待ち) になった issue を、ポイントと実際にかかった節目と一緒に記録する。
 * sprint の設定が無ければ何もしない。Status の変化は、済んだ issue だけを 1 回で問い合わせる。
 */
export function recordCompletions(
  p: Paths,
  previous: Snapshot | null,
  fresh: Snapshot,
  config: Config,
  now: Date,
  readEvents: BoardSource['statusEvents'],
): readonly Completion[] {
  if (config.sprint === undefined) return []
  const alreadyRecorded = alreadyLogged(previous, loadCompletions(p))
  const pairs = newlyFinished(previous, fresh, config).filter((pair) => !alreadyRecorded.has(label(pair.item)))
  if (pairs.length === 0) return []
  const statusHistory = readEvents(pairs.map((pair) => pair.item))
  const countingHistory = loadCountingHistory(p, now)
  const completions = pairs.map((pair) => toCompletion(pair, statusHistory, countingHistory, config, now))
  completions.forEach((one) => appendLine(p.completions, JSON.stringify(one)))
  return completions
}

export function loadCompletions(p: Paths): readonly Completion[] {
  return readText(p.completions)
    .split('\n')
    .filter((line) => line !== '')
    .flatMap((line): readonly Completion[] => {
      try {
        return [JSON.parse(line) as Completion]
      } catch {
        return []
      }
    })
}
