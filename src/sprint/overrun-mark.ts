import type { IssueComment } from '../ports/index.ts'

export type { IssueComment }

/** 超過の扱いの決め方。見積もりを直す、分ける、手を足す、見積もりのまま (超えた分は待ち) の 4 つ。 */
export const OVERRUN_DECISIONS = ['reestimate', 'split', 'add-hands', 'keep'] as const
export type OverrunDecision = (typeof OVERRUN_DECISIONS)[number]

/** 超過の扱いを決めた印。issue のコメントの 1 行目に、人が読む文より前に置く HTML コメント。 */
export type OverrunMark = {
  readonly decision: OverrunDecision
  readonly from: number
  readonly to: number
}

const MARK_LINE = /^<!-- scrum:points-overrun decision=([a-z-]+) from=(\d+) to=(\d+) -->$/

/** コメントの 1 行目が印なら、その中身。印でなければ、決めが 4 つのどれでもなければ null。 */
export function parseOverrunMark(body: string): OverrunMark | null {
  const found = MARK_LINE.exec(body.split('\n', 1)[0]?.trim() ?? '')
  if (found === null) return null
  const decision = OVERRUN_DECISIONS.find((one) => one === found[1])
  return decision === undefined ? null : { decision, from: Number(found[2]), to: Number(found[3]) }
}

/** 印の中身が、決めと合っているか。合っていなければ、その理由。 */
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
 * S-POINTS-OVER を受け入れてよいか。超過を出した節目 (overSince) より後に付いた、正しい印のコメントが 1 つでもあれば、その印を根拠にする。
 * 無ければ、受け入れない (見積もりを直したか、分けたか、手を足したか、見積もりのままにすると決めた記録が、まだ無い)。
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
