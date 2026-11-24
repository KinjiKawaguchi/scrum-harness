import { label } from '../board/rules.ts'
import { loadSnapshot } from '../board/snapshot.ts'
import type { Config } from '../config.ts'
import type { Paths } from '../store.ts'
import { assessItem } from './assess.ts'
import type { IssueThread } from '../ports/index.ts'
import { overrunBasis, type OverrunBasis } from './overrun-mark.ts'
import { loadCountingHistory } from './counting-history.ts'

const refuse = (message: string): OverrunBasis => ({ ok: false, message })

/**
 * `scrum ack S-POINTS-OVER <issue>` を受け入れてよいか。超過が出ている issue に、超過を出した節目より後の、正しい印のコメントがあるときだけ、
 * その印を根拠にして受け入れる。見積もりを直した記録が無いまま、振り返りに回すと言って消すことを止める。
 */
export function checkOverrunAck(
  p: Paths,
  subject: string,
  config: Config | null,
  now: Date,
  issues: Pick<IssueThread, 'comments'> | null,
): OverrunBasis {
  if (config === null || config.sprint === undefined) return refuse('sprint の設定が無いので、S-POINTS-OVER の受け入れは記録できない')
  if (issues === null) return refuse('issue のコメントを読む手段が無いので、S-POINTS-OVER の受け入れは記録できない')
  const item = loadSnapshot(p)?.items.find((one) => one.kind === 'issue' && label(one) === subject)
  if (item === undefined || item.number === null) return refuse(`${subject} が控えに無い (番号の書き方か、閉じたかを見る。S-POINTS-OVER は作業中の issue に出る)`)
  const assessment = assessItem(item, loadCountingHistory(p, now), config, now)
  if (assessment.over === null || assessment.over <= 0 || assessment.overSince === undefined || assessment.overSince === null) {
    return refuse(`${subject} に、いま S-POINTS-OVER は出ていない (手間 ${assessment.effort ?? '不明'}、目安 ${assessment.budget ?? '不明'})。受け入れは要らない`)
  }
  try {
    return overrunBasis(issues.comments(item), assessment.overSince, item.points ?? null)
  } catch (error) {
    return refuse(`${subject} の issue のコメントを読めなかったので、受け入れを記録しない: ${error instanceof Error ? error.message : String(error)}`)
  }
}
