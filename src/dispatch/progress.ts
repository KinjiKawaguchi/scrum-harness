import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import type { Config } from '../config.ts'
import { readJson, writeJson, type Paths } from '../store.ts'

/**
 * issue の作業が進んだかを見るための印。促しを送った時点の印と、いまの印を比べて、違えば作業が進んだ。
 * board は、ボードの Status、止まっている理由、担当、止まり始めた日。github は、コードの置き場から取る印 (CodeHost.activity。読めなければ null)。
 */
export type ProgressToken = { readonly board: string; readonly github: string | null }

/** 印を取る。 */
export type TokenOf = (item: BoardItem) => ProgressToken

/** コードの置き場から取る印の部分 (読めなければ null か、投げる)。 */
export type ProgressProbe = (item: BoardItem) => string | null

export function boardToken(item: BoardItem): string {
  return [item.status ?? '', item.reason ?? '', item.assignee ?? '', item.since ?? ''].join('|')
}

/** 印が変わっていれば、作業が進んだ。どちらかが無い (記録の前の形) ときと、コードの置き場の印がどちらかで読めていないときは、進んだとは言わない。 */
export function hasProgress(before: ProgressToken | undefined, after: ProgressToken | undefined): boolean {
  if (before === undefined || after === undefined) return false
  if (before.board !== after.board) return true
  return before.github !== null && after.github !== null && before.github !== after.github
}

/**
 * 部下ごと、issue ごとに、最後に見た印と、印が変わった (作業が進んだ) 時刻。
 * 進んで idleMinutes たつまでは促さず、A-NUDGE-IGNORED も、促しの判断と同じ印 (コードの置き場の印を含む) で比べるために持つ。
 */
export type SeenProgress = { readonly token: ProgressToken; readonly at: string }
export type SeenMap = Readonly<Record<string, SeenProgress>>

export function seenKey(member: string, issue: string): string {
  return `${member}|${issue}`
}

/**
 * 印を見たことを覚える。前と比べて進んでいれば (初めて見たときも) 時刻を今にし、変わっていなければ前の時刻のまま。
 * 同じ部下の、別の issue の分は捨てる (自分の作業中が変われば、前の issue の印は要らない)。
 */
export function observe(seen: SeenMap, member: string, issue: string, token: ProgressToken, now: Date): SeenMap {
  const before = seen[seenKey(member, issue)]
  const at = before === undefined || hasProgress(before.token, token) ? now.toISOString() : before.at
  const others = Object.entries(seen).filter(([key]) => !key.startsWith(`${member}|`))
  return Object.fromEntries([...others, [seenKey(member, issue), { token, at }]])
}

const isToken = (value: unknown): value is ProgressToken => {
  const token = value as { board?: unknown; github?: unknown } | null
  return typeof token === 'object' && token !== null && typeof token.board === 'string' && (token.github === null || typeof token.github === 'string')
}

const isSeenProgress = (value: unknown): value is SeenProgress => {
  const seen = value as { token?: unknown; at?: unknown } | null
  return typeof seen === 'object' && seen !== null && isToken(seen.token) && typeof seen.at === 'string' && !Number.isNaN(Date.parse(seen.at))
}

/** 保存した印を読む。無いか、形が違う項目は捨てる。 */
export function readSeen(p: Paths): SeenMap {
  const raw = readJson<unknown>(p.dispatchSeen, {})
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => isSeenProgress(value)))
}

export function writeSeen(p: Paths, seen: SeenMap): void {
  writeJson(p.dispatchSeen, seen)
}

/** コードの置き場の印を使わず、ボードの印だけで比べる。 */
export const boardOnly: TokenOf = (item) => ({ board: boardToken(item), github: null })

const CACHE_TTL_MS = 5 * 60_000

/** 同じ issue の印の読み取りを、ttlMs の間は使い回す (30 秒ごとの待機が、外を叩き続けないため)。失敗も使い回す。 */
export function cachedProbe(probe: ProgressProbe, ttlMs: number = CACHE_TTL_MS, clock: () => number = Date.now): ProgressProbe {
  const cache = new Map<string, { readonly at: number; readonly value: string | null }>()
  return (item) => {
    const key = `${item.repo}#${item.number}`
    const hit = cache.get(key)
    if (hit !== undefined && clock() - hit.at < ttlMs) return hit.value
    const value = (() => {
      try {
        return probe(item)
      } catch {
        return null
      }
    })()
    cache.set(key, { at: clock(), value })
    return value
  }
}

/**
 * ボードの印と、コードの置き場の印を合わせた、いまの印。読めなければ、コードの置き場の印は null (ボードの印だけで比べる)。
 * ポートの約束では印の読み取りは投げてよいので、ここで受け止める (投げたまま渡しの錠の中に届くと、渡すこと自体を数分止めてしまう)。
 */
export function tokenWith(probe: ProgressProbe): TokenOf {
  return (item) => ({ board: boardToken(item), github: readProbe(probe, item) })
}

function readProbe(probe: ProgressProbe, item: BoardItem): string | null {
  try {
    return probe(item)
  } catch {
    return null
  }
}

/** 促しの記録に書く名前。label を使うので、同じ issue かの比べは、リポジトリ名と番号で決まる。 */
export function issueLabel(item: BoardItem): string {
  return label(item)
}
