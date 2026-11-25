import type { UsageIndex } from './index-store.ts'
import { costOf, roundToCents } from './pricing.ts'

export type PersonTokens = { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }

export type UsageSummary = {
  /** Oldest first, one entry per calendar day, today last */
  readonly byDay: readonly { readonly date: string; readonly costUsd: Readonly<Record<string, number>> }[]
  /** Most expensive first */
  readonly byPerson: readonly { readonly person: string; readonly costUsd: number; readonly tokens: PersonTokens }[]
}

export type SummaryInput = {
  readonly index: UsageIndex
  /** Session id → team member. A session that is not in it is not counted. */
  readonly memberOf: ReadonlyMap<string, string>
  readonly days: number
  readonly now: Date
  /** The time zone the days are cut in, as minutes east of UTC */
  readonly offsetMinutes: number
}

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

const dateOf = (at: number, offsetMinutes: number): string => new Date(at + offsetMinutes * MINUTE_MS).toISOString().slice(0, 10)

/** The last `days` calendar dates in the time zone, oldest first, today last. A fixed offset has no daylight saving, so a day is 24 hours. */
export function lastDates(days: number, now: Date, offsetMinutes: number): readonly string[] {
  return Array.from({ length: days }, (_, i) => dateOf(now.getTime() - (days - 1 - i) * DAY_MS, offsetMinutes))
}

type Total = { cost: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } }

export function summarize({ index, memberOf, days, now, offsetMinutes }: SummaryInput): UsageSummary {
  const dates = lastDates(days, now, offsetMinutes)
  const byDay = new Map(dates.map((date) => [date, new Map<string, number>()]))
  const byPerson = new Map<string, Total>()
  for (const [session, minute, model, fast, input, write5m, write1h, read, output] of index.rows) {
    const person = memberOf.get(index.sessionIds[session] ?? '')
    const at = minute * MINUTE_MS
    const date = dateOf(at, offsetMinutes)
    const day = byDay.get(date)
    if (person === undefined || day === undefined || at > now.getTime()) continue
    const cost = costOf(index.models[model] ?? '', { input, cacheWrite5m: write5m, cacheWrite1h: write1h, cacheRead: read, output }, fast === 1)
    day.set(person, (day.get(person) ?? 0) + cost)
    const total = byPerson.get(person) ?? { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    total.cost += cost
    total.tokens.input += input
    total.tokens.output += output
    total.tokens.cacheRead += read
    total.tokens.cacheWrite += write5m + write1h
    byPerson.set(person, total)
  }
  return {
    byDay: dates.map((date) => ({ date, costUsd: Object.fromEntries([...(byDay.get(date) ?? [])].map(([person, cost]) => [person, roundToCents(cost)])) })),
    byPerson: [...byPerson]
      .map(([person, total]) => ({ person, costUsd: roundToCents(total.cost), tokens: total.tokens, raw: total.cost }))
      .toSorted((a, b) => b.raw - a.raw || a.person.localeCompare(b.person))
      .map(({ raw: _raw, ...entry }) => entry),
  }
}
