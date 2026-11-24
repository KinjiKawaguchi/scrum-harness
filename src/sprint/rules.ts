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

const tiers = (sprint: SprintConfig): string => Object.keys(sprint.pointBudgets).join('、')

/** 全セッションが止まっていて手間から除いた節目があれば、その数を書く。 */
const teamStoppedText = (assessment: Assessment): string =>
  assessment.teamStopped === undefined ? '' : `。全セッションが止まっていて除いた節目 ${assessment.teamStopped}`

function overFinding(assessment: Assessment): Finding {
  return makeFinding({
    rule: 'S-POINTS-OVER',
    subject: assessment.label,
    keySuffix: String(assessment.over),
    severity: 'medium',
    message: `${assessment.label} は ${assessment.points} ポイント (目安 ${assessment.budget} 節目) に対して ${assessment.effort} 節目かかっている (+${assessment.over})。止まっていた節目は除いた${teamStoppedText(assessment)}`,
    fix: '次の節目の振り返りで、見積もりを直すか、分けるか、手を足すかを決める',
  })
}

function pointsFindings(assessment: Assessment, sprint: SprintConfig): readonly Finding[] {
  if (assessment.points === null) {
    return [
      makeFinding({
        rule: 'S-POINTS-MISSING',
        subject: assessment.label,
        severity: 'medium',
        message: `${assessment.label} にストーリーポイントが無い`,
        fix: `節目の前に「${sprint.pointsField}」に ${tiers(sprint)} のどれかを入れる`,
      }),
    ]
  }
  if (assessment.budget === null) {
    return [
      makeFinding({
        rule: 'S-POINTS-INVALID',
        subject: assessment.label,
        severity: 'low',
        message: `${assessment.label} のストーリーポイント ${assessment.points} が段 (${tiers(sprint)}) に無い`,
        fix: `「${sprint.pointsField}」を ${tiers(sprint)} のどれかにする`,
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
  const when = recordedAt - at.getTime() > LATE_MS ? ` を ${localClock(recordedAt, sprint)} に` : ' を'
  const over = record.items.filter((item) => item.over !== null && item.over > 0)
  const overText = over.length === 0 ? '' : ` (${over.map((item) => `${item.label} +${item.over}`).join('、')})`
  return makeFinding({
    rule: 'S-CHECKPOINT',
    subject: 'sprint',
    keySuffix: record.scheduledFor,
    severity: 'medium',
    message: `節目 ${localClock(at.getTime(), sprint)}${when}記録した。作業中 ${record.items.length} 件、超過 ${over.length} 件${overText}。振り返りと、次の節目 (${localClock(nextCheckpoint(at, sprint).getTime(), sprint)}) までの順を決める`,
    fix: `${SCRUM_CLI} points で一覧を見る`,
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

