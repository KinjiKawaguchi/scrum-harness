import type { Config } from '../config.ts'
import type { MemberSpec } from '../members/config.ts'
import type { BudgetStatus, Ports } from '../ports/index.ts'
import { currentBudget, describeBudget, nextWeek, readBudgetRecord } from './record.ts'

/** What the weekly budget says about starting one member: not at all, on another model, or as usual. `note` is for the line the start prints. */
export type BudgetGate = { readonly refusal?: string; readonly model?: string; readonly note?: string }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200)

/**
 * The budget the team has now: the node's answer, or, when it cannot be asked, the kept one while it is fresh. Starting never waits on a node that is down:
 * with neither, the member starts as usual, and the note says why.
 */
function statusNow(ports: Ports, path: string | undefined, now: Date): { readonly status: BudgetStatus | null; readonly problem?: string } {
  if (ports.budget === null) return { status: null }
  try {
    return { status: ports.budget() }
  } catch (error) {
    return { status: path === undefined ? null : currentBudget(readBudgetRecord(path), now), problem: message(error) }
  }
}

/**
 * At `over` a new member is not started (a restart of one that ran counts as new work). At `warning` it starts on the cheaper model: the member's own
 * `warningModel`, else the one set for its product in `launch.budget`; with none set the model is left alone, and the note says so.
 */
export function budgetGate(config: Config, ports: Ports, spec: MemberSpec, budgetPath: string | undefined, now: Date): BudgetGate {
  const budget = config.launch?.budget
  if (budget === undefined) return {}
  const { status, problem } = statusNow(ports, budgetPath, now)
  if (status === null) return problem === undefined ? {} : { note: `the weekly budget could not be asked (${problem}); starting as usual` }
  if (status.team.state === 'over') return { refusal: `the weekly budget is used (${describeBudget(status)}); no new member is started until ${nextWeek(status.weekStart)}` }
  if (status.team.state === 'ok') return {}
  const model = spec.warningModel ?? budget.warningModel?.[spec.product ?? 'claude-code']
  const text = `the weekly budget is at 80% or more (${describeBudget(status)})`
  return model === undefined ? { note: `${text}; no warningModel is set for this member, so its model is unchanged` } : { model, note: `${text}; starting on ${model}` }
}
