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
 * Whether `scrum ack S-POINTS-OVER <issue>` may be accepted. Only when an issue with an overrun has a valid marker comment posted after the checkpoint at which the overrun was raised,
 * it is accepted on the basis of that marker. This stops the finding from being cleared by saying it will go to the retrospective without any record that the estimate was fixed.
 */
export function checkOverrunAck(
  p: Paths,
  subject: string,
  config: Config | null,
  now: Date,
  issues: Pick<IssueThread, 'comments'> | null,
): OverrunBasis {
  if (config === null || config.sprint === undefined) return refuse('There is no sprint configuration, so an S-POINTS-OVER acknowledgement cannot be recorded')
  if (issues === null) return refuse('There is no way to read issue comments, so an S-POINTS-OVER acknowledgement cannot be recorded')
  const item = loadSnapshot(p)?.items.find((one) => one.kind === 'issue' && label(one) === subject)
  if (item === undefined || item.number === null) return refuse(`${subject} is not in the board copy (check how the number is written, or whether it was closed. S-POINTS-OVER shows on In Progress issues)`)
  const assessment = assessItem(item, loadCountingHistory(p, now), config, now)
  if (assessment.over === null || assessment.over <= 0 || assessment.overSince === undefined || assessment.overSince === null) {
    return refuse(`${subject} has no S-POINTS-OVER now (effort ${assessment.effort ?? 'unknown'}, budget ${assessment.budget ?? 'unknown'}). No acknowledgement is needed`)
  }
  try {
    return overrunBasis(issues.comments(item), assessment.overSince, item.points ?? null)
  } catch (error) {
    return refuse(`Could not read the comments of the issue ${subject}, so the acknowledgement is not recorded: ${error instanceof Error ? error.message : String(error)}`)
  }
}
