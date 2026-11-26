/** How much of a weekly budget is used: `ok` below 80%, or without a cap; `warning` from 80% up to 100%; `over` at 100% and more. */
export type BudgetState = 'ok' | 'warning' | 'over'

/** One budget, a team's or its org's. Dollars are API-priced estimates, as in a token usage report. */
export type BudgetLine = {
  /** Absent when there is no cap */
  readonly capUsd?: number
  readonly spentUsd: number
  readonly state: BudgetState
  /** True when some of the spend could not be read (a team on a node that did not answer), so it is a lower bound */
  readonly partial?: boolean
}

/** The node's answer for this week: the team's budget and its org's. A team is `over` when its own cap or its org's is over (the node already says so in `team.state`). */
export type BudgetStatus = {
  /** The first day of the calendar week, `YYYY-MM-DD` (Monday, in the node's time zone) */
  readonly weekStart: string
  readonly team: BudgetLine
  readonly org: BudgetLine
}

/** Asks the node for this week's budget of the team. Throws, with the reason, when it cannot be asked or does not answer. */
export type BudgetReader = () => BudgetStatus
