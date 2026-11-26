import { SCRUM_CLI } from '../cli-path.ts'
import { makeFinding, type Finding } from '../findings/types.ts'
import type { BudgetStatus } from '../ports/index.ts'
import { describeBudget, nextWeek } from './record.ts'

/**
 * B-BUDGET-OVER: the team's weekly budget is used (its own cap, or its org's). High, so the TechLead hears of it at once: no new member is started and no
 * board item is handed out until the week ends. B-BUDGET-WARNING: the budget is at 80% or more; new members start on the cheaper model. Low. Both go away
 * by themselves when the node says `ok` (a new week, or a higher cap), or when its answer is too old to act on.
 */
export function lintBudget(status: BudgetStatus | null): readonly Finding[] {
  if (status === null || status.team.state === 'ok') return []
  const text = describeBudget(status)
  if (status.team.state === 'over') {
    return [
      makeFinding({
        rule: 'B-BUDGET-OVER',
        subject: 'team',
        severity: 'high',
        message: `The weekly budget is used: ${text}. No new member is started and no board item is handed out until ${nextWeek(status.weekStart)}`,
        fix: `Raise the cap in the org definition, or wait for the reset. Running members finish their task; assigning by hand still works (${SCRUM_CLI} refresh re-reads the budget)`,
        keySuffix: status.weekStart,
      }),
    ]
  }
  return [
    makeFinding({
      rule: 'B-BUDGET-WARNING',
      subject: 'team',
      severity: 'low',
      message: `The weekly budget is at 80% or more: ${text}. New members start on the cheaper model, where one is set`,
      keySuffix: status.weekStart,
    }),
  ]
}
