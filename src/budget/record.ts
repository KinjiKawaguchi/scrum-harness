import type { BudgetLine, BudgetStatus, Ports } from '../ports/index.ts'
import { readJson, writeJson } from '../store.ts'

/** What the node last said of the team's weekly budget, and when. Hooks and the dispatch read this file; only a refresh or a member start asks the node. */
export type BudgetRecord = { readonly at: string; readonly status: BudgetStatus }

/** An answer older than this is not acted on: a node that stopped answering must not keep a team stopped, or warned, for a week that may be over. */
export const STALE_HOURS = 3

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isLine = (value: unknown): value is BudgetLine => isObject(value) && typeof value.spentUsd === 'number' && ['ok', 'warning', 'over'].includes(value.state as string)

export function readBudgetRecord(path: string): BudgetRecord | null {
  const stored = readJson<unknown>(path, null)
  if (!isObject(stored) || typeof stored.at !== 'string' || !isObject(stored.status)) return null
  const { weekStart, team, org } = stored.status
  return typeof weekStart === 'string' && isLine(team) && isLine(org) ? { at: stored.at, status: { weekStart, team, org } } : null
}

/** The kept status, or null when there is none or it is too old to act on. */
export function currentBudget(record: BudgetRecord | null, now: Date): BudgetStatus | null {
  return record !== null && now.getTime() - Date.parse(record.at) < STALE_HOURS * 3_600_000 ? record.status : null
}

/**
 * Asks the node for this week's budget and keeps the answer. Returns why it could not, and then keeps what it had. Null when there is no `launch.budget`,
 * or it worked.
 */
export function refreshBudget(ports: Ports, path: string, now: Date): string | null {
  if (ports.budget === null) return null
  try {
    writeJson(path, { at: now.toISOString(), status: ports.budget() } satisfies BudgetRecord)
    return null
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 300)
  }
}

const dollars = (amount: number): string => `$${Math.round(amount)}`
const lineText = (line: BudgetLine): string => `${dollars(line.spentUsd)}${line.capUsd === undefined ? '' : ` of ${dollars(line.capUsd)}`}${line.partial === true ? ' (partial: some spend could not be read)' : ''}`

/** `team $163 of $200; org $311 of $500` */
export function describeBudget(status: BudgetStatus): string {
  return `team ${lineText(status.team)}; org ${lineText(status.org)}`
}

/** The first day of the next calendar week, from the first day of this one (`YYYY-MM-DD`). */
export function nextWeek(weekStart: string): string {
  const next = new Date(`${weekStart}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 7)
  return next.toISOString().slice(0, 10)
}
