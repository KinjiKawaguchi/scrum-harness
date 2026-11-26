import { currentBudget, readBudgetRecord } from './record.ts'

/**
 * Whether the team's weekly budget is used, as the node last said (an answer older than 3 hours does not count). While it is, no board item is handed to an idle
 * member. Reads only the kept answer, never the node, so a hook or a watch can ask it every few seconds.
 */
export function isHandOverHeld(budgetPath: string, now: Date): boolean {
  return currentBudget(readBudgetRecord(budgetPath), now)?.team.state === 'over'
}
