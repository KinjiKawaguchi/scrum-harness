import type { UsageIndex } from './index-store.ts'
import { costOf, roundToCents } from './pricing.ts'
import { lastDates, type PersonTokens } from './summary.ts'

const MINUTE_MS = 60_000

/** One person's cost and tokens on one calendar day. */
export type DayUsage = { readonly date: string; readonly costUsd: number; readonly tokens: PersonTokens }

export type DailyUsageInput = {
  readonly index: UsageIndex
  /** Session id → team member. A session that is not in it is not counted. */
  readonly memberOf: ReadonlyMap<string, string>
  readonly days: number
  readonly now: Date
  /** The time zone the days are cut in, as minutes east of UTC */
  readonly offsetMinutes: number
}

type Total = { cost: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } }

/**
 * Each member's cost and tokens by calendar day over the last `days` days, from the index of the transcripts: the days `summarize` totals, with the tokens
 * of each day too. Oldest day first; a member has an entry only for a day with some use, and a member with none in the range has none.
 */
export function dailyUsage({ index, memberOf, days, now, offsetMinutes }: DailyUsageInput): ReadonlyMap<string, readonly DayUsage[]> {
  const dates = new Set(lastDates(days, now, offsetMinutes))
  const totals = new Map<string, Map<string, Total>>()
  for (const [session, minute, model, fast, input, write5m, write1h, read, output] of index.rows) {
    const person = memberOf.get(index.sessionIds[session] ?? '')
    const at = minute * MINUTE_MS
    const date = new Date(at + offsetMinutes * MINUTE_MS).toISOString().slice(0, 10)
    if (person === undefined || !dates.has(date) || at > now.getTime()) continue
    const cost = costOf(index.models[model] ?? '', { input, cacheWrite5m: write5m, cacheWrite1h: write1h, cacheRead: read, output }, fast === 1)
    const own = totals.get(person) ?? new Map<string, Total>()
    const day = own.get(date) ?? { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    day.cost += cost
    day.tokens.input += input
    day.tokens.output += output
    day.tokens.cacheRead += read
    day.tokens.cacheWrite += write5m + write1h
    own.set(date, day)
    totals.set(person, own)
  }
  return new Map(
    [...totals].map(([person, own]) => [
      person,
      [...own].toSorted(([a], [b]) => a.localeCompare(b)).map(([date, day]): DayUsage => ({ date, costUsd: roundToCents(day.cost), tokens: day.tokens })),
    ]),
  )
}
