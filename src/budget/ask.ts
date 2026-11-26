import { requestCommand } from '../requests/command.ts'
import type { BudgetStatus } from '../ports/index.ts'
import { readJson, writeJson, type Paths } from '../store.ts'
import { describeBudget, nextWeek } from './record.ts'

/** The name the harness files its own requests under. */
const FROM = 'harness'

/** The week the owner was last asked about, so one request is filed per week however often the budget is read. */
type Asked = { readonly weekStart?: string; readonly requestId?: string; readonly at?: string }

/**
 * When the team's weekly budget is used, files one request for the owner (`scrum request add`): what is used, what is stopped, and the two ways out. Once per
 * week. Returns a line to print when it filed one (or could not), and null otherwise. It does not create a board issue.
 */
export function askOwnerWhenOver(p: Paths, status: BudgetStatus | null, now: Date): string | null {
  if (status === null || status.team.state !== 'over') return null
  if (readJson<Asked>(p.budgetAsked, {}).weekStart === status.weekStart) return null
  const reset = nextWeek(status.weekStart)
  const body = {
    title: `The weekly budget is used (until ${reset})`,
    context: `${describeBudget(status)}. Until the week ends (${reset}) no new member is started and no board item is handed to an idle member. Running members finish their task, and the TechLead can still assign by hand.`,
    kind: 'question',
    options: [
      { key: 'wait', text: `Wait for the reset on ${reset}`, isRecommended: true, detail: 'Nothing changes: the team resumes by itself when the new week starts.' },
      { key: 'raise', text: 'Raise the cap in the org definition', detail: 'The team resumes at the next refresh after the node reports the new cap.' },
    ],
  }
  const result = requestCommand(p, ['add'], { from: FROM }, JSON.stringify(body), now)
  if (!result.startsWith('added: ')) return `could not ask the owner about the weekly budget: ${result}`
  const requestId = result.slice('added: '.length)
  writeJson(p.budgetAsked, { weekStart: status.weekStart, requestId, at: now.toISOString() } satisfies Asked)
  return `asked the owner about the weekly budget (request ${requestId})`
}
