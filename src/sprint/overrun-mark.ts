import type { IssueComment } from '../ports/index.ts'

export type { IssueComment }

/** The ways to settle an overrun. Four: revise the estimate, split, add hands, or keep the estimate (the excess is waited out). */
export const OVERRUN_DECISIONS = ['reestimate', 'split', 'add-hands', 'keep'] as const
export type OverrunDecision = (typeof OVERRUN_DECISIONS)[number]

/** The marker that records how the overrun was settled. An HTML comment placed on the first line of an issue comment, before the text a person reads. */
export type OverrunMark = {
  readonly decision: OverrunDecision
  readonly from: number
  readonly to: number
}

const MARK_LINE = /^<!-- scrum:points-overrun decision=([a-z-]+) from=(\d+) to=(\d+) -->$/

/** If the first line of the comment is a marker, its content. null if it is not a marker, or if the decision is none of the four. */
export function parseOverrunMark(body: string): OverrunMark | null {
  const found = MARK_LINE.exec(body.split('\n', 1)[0]?.trim() ?? '')
  if (found === null) return null
  const decision = OVERRUN_DECISIONS.find((one) => one === found[1])
  return decision === undefined ? null : { decision, from: Number(found[2]), to: Number(found[3]) }
}

/** Whether the marker's content agrees with the decision. If not, the reason. */
function markProblem(mark: OverrunMark, boardPoints: number | null): string | null {
  if (mark.decision === 'keep' && mark.from !== mark.to) return `keep leaves the estimate as it is, so from and to must be the same (from=${mark.from} to=${mark.to})`
  if (mark.decision === 'reestimate' && mark.from === mark.to) return `reestimate changes the estimate, so from and to must differ (from=${mark.from} to=${mark.to})`
  if (mark.decision === 'reestimate' && boardPoints !== mark.to) {
    return `The mark's to=${mark.to} differs from the points on the board (${boardPoints ?? 'none'}). Fix the board points first`
  }
  return null
}

export type OverrunBasis = { readonly ok: true; readonly basis: string } | { readonly ok: false; readonly message: string }

/**
 * Whether S-POINTS-OVER may be accepted. If there is even one valid marker comment posted after the checkpoint at which the overrun was raised (overSince), that marker is the basis.
 * If there is none, it is not accepted (there is no record that it was decided to revise the estimate, split, add hands, or keep the estimate).
 */
export function overrunBasis(comments: readonly IssueComment[], overSince: string, boardPoints: number | null): OverrunBasis {
  const after = comments
    .filter((comment) => Date.parse(comment.createdAt) > Date.parse(overSince))
    .flatMap((comment) => {
      const mark = parseOverrunMark(comment.body)
      return mark === null ? [] : [{ comment, mark }]
    })
    .toSorted((a, b) => Date.parse(b.comment.createdAt) - Date.parse(a.comment.createdAt))
  const valid = after.find(({ mark }) => markProblem(mark, boardPoints) === null)
  if (valid !== undefined) {
    const { mark, comment } = valid
    return { ok: true, basis: `decision=${mark.decision} from=${mark.from} to=${mark.to}${comment.url === undefined ? '' : ` (${comment.url})`}` }
  }
  const problem = after[0] === undefined ? null : markProblem(after[0].mark, boardPoints)
  const detail = problem === null ? `the issue has no mark for handling the overrun, added after the checkpoint that showed the overrun (${overSince})` : `there is a mark, but ${problem}`
  return {
    ok: false,
    message: `An S-POINTS-OVER acknowledgement is not accepted until a record is added (a mark on the first line of an issue comment) that says whether the estimate is revised, the issue is split, hands are added, or the estimate is kept: ${detail}. The mark is <!-- scrum:points-overrun decision=<${OVERRUN_DECISIONS.join('|')}> from=<previous points> to=<new points> -->`,
  }
}
