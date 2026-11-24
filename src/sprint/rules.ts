import type { Snapshot } from '../board/types.ts'
import { SCRUM_CLI } from '../cli-path.ts'
import type { Config, SprintConfig } from '../config.ts'
import { makeFinding, type Finding } from '../findings/types.ts'
import { assessItem, type Assessment } from './assess.ts'
import { localClock, nextCheckpoint } from './checkpoints.ts'
import type { CountingHistory } from './counting-history.ts'
import { doingIssues, type CheckpointRecord } from './record.ts'

/** 節目の知らせを、記録してから出し続ける時間。 */
const CHECKPOINT_NOTICE_MS = 60 * 60 * 1000

const tiers = (sprint: SprintConfig): string => Object.keys(sprint.pointBudgets).join(', ')

/** 全セッションが止まっていて手間から除いた節目があれば、その数を書く。 */
const teamStoppedText = (assessment: Assessment): string =>
  assessment.teamStopped === undefined ? '' : `. Checkpoints excluded because all sessions were stopped: ${assessment.teamStopped}`

function overFinding(assessment: Assessment): Finding {
  return makeFinding({
    rule: 'S-POINTS-OVER',
    subject: assessment.label,
    keySuffix: String(assessment.over),
    severity: 'medium',
    message: `${assessment.label} has taken ${assessment.effort} checkpoints against ${assessment.points} points (budget ${assessment.budget} checkpoints) (+${assessment.over}). Checkpoints with a block are excluded${teamStoppedText(assessment)}`,
    fix: 'At the next checkpoint review, decide whether to revise the estimate, split the issue, or add hands',
  })
}

function pointsFindings(assessment: Assessment, sprint: SprintConfig): readonly Finding[] {
  if (assessment.points === null) {
    return [
      makeFinding({
        rule: 'S-POINTS-MISSING',
        subject: assessment.label,
        severity: 'medium',
        message: `${assessment.label} has no story points`,
        fix: `Before the checkpoint, set "${sprint.pointsField}" to one of ${tiers(sprint)}`,
      }),
    ]
  }
  if (assessment.budget === null) {
    return [
      makeFinding({
        rule: 'S-POINTS-INVALID',
        subject: assessment.label,
        severity: 'low',
        message: `The story points ${assessment.points} of ${assessment.label} are not in the tiers (${tiers(sprint)})`,
        fix: `Set "${sprint.pointsField}" to one of ${tiers(sprint)}`,
      }),
    ]
  }
  return assessment.over !== null && assessment.over > 0 ? [overFinding(assessment)] : []
}

/** 節目の時刻からこれより遅れて記録したら、記録した時刻も知らせに書く。 */
const LATE_MS = 5 * 60 * 1000

function checkpointFinding(record: CheckpointRecord, sprint: SprintConfig): Finding {
  const at = new Date(record.scheduledFor)
  const recordedAt = Date.parse(record.recordedAt)
  const when = recordedAt - at.getTime() > LATE_MS ? ` (recorded late, at ${localClock(recordedAt, sprint)})` : ''
  const over = record.items.filter((item) => item.over !== null && item.over > 0)
  const overText = over.length === 0 ? '' : ` (${over.map((item) => `${item.label} +${item.over}`).join(', ')})`
  return makeFinding({
    rule: 'S-CHECKPOINT',
    subject: 'sprint',
    keySuffix: record.scheduledFor,
    severity: 'medium',
    message: `Recorded checkpoint ${localClock(at.getTime(), sprint)}${when}. ${record.items.length} In Progress, ${over.length} over budget${overText}. Review, and decide the order until the next checkpoint (${localClock(nextCheckpoint(at, sprint).getTime(), sprint)})`,
    fix: `See the list with ${SCRUM_CLI} points`,
  })
}

function lintCheckpoint(records: readonly CheckpointRecord[], sprint: SprintConfig, now: Date): readonly Finding[] {
  const latest = records.toSorted((a, b) => a.scheduledFor.localeCompare(b.scheduledFor)).at(-1)
  if (latest === undefined) return []
  const age = now.getTime() - Date.parse(latest.recordedAt)
  return age >= 0 && age < CHECKPOINT_NOTICE_MS ? [checkpointFinding(latest, sprint)] : []
}

/** ストーリーポイントと節目の指摘。sprint の設定が無ければ何も出さない。 */
export function lintSprint(snapshot: Snapshot, history: CountingHistory, config: Config, now: Date): readonly Finding[] {
  const sprint = config.sprint
  if (sprint === undefined) return []
  const next = snapshot.items.filter(
    (item) => item.kind === 'issue' && item.state === 'OPEN' && item.status === config.statuses.next && !config.excludeAuthors.includes(item.author ?? ''),
  )
  const targets = [...doingIssues(snapshot, config), ...next]
  const items = targets.flatMap((item) => pointsFindings(assessItem(item, history, config, now), sprint))
  return [...items, ...lintCheckpoint(history.records, sprint, now)]
}

