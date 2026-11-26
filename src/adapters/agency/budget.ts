import type { BudgetConfig } from '../../budget/config.ts'
import type { BudgetLine, BudgetReader, BudgetState, BudgetStatus } from '../../ports/index.ts'
import { jsonOf, runAgency } from './run.ts'

const STATES: readonly BudgetState[] = ['ok', 'warning', 'over']
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

function lineOf(value: unknown, which: string): BudgetLine {
  if (!isObject(value)) throw new Error(`its answer has no ${which}`)
  const { capUsd, spentUsd, state, partial } = value
  if (!STATES.includes(state as BudgetState)) throw new Error(`the state of its ${which} is not one of ${STATES.join(', ')}`)
  if (!isAmount(spentUsd)) throw new Error(`the spend of its ${which} is not an amount`)
  if (capUsd !== undefined && !isAmount(capUsd)) throw new Error(`the cap of its ${which} is not an amount`)
  return { state: state as BudgetState, spentUsd, ...(capUsd === undefined ? {} : { capUsd }), ...(partial === true ? { partial: true } : {}) }
}

/**
 * Asks `agency budget status --org <org> --team <team>`: one JSON object on stdout, exit 0. The program is a file of the user that others cannot write.
 * Throws, with the program's own words, when it cannot answer.
 */
export function agencyBudgetReader(config: BudgetConfig): BudgetReader {
  return (): BudgetStatus => {
    const answer = jsonOf(runAgency(config, ['status', '--org', config.org, '--team', config.team], [0]).stdout)
    if (!isObject(answer)) throw new Error('it did not answer an object')
    if (typeof answer.weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(answer.weekStart)) throw new Error('its weekStart is not a date (YYYY-MM-DD)')
    return { weekStart: answer.weekStart, team: lineOf(answer.team, 'team'), org: lineOf(answer.org, 'org') }
  }
}
