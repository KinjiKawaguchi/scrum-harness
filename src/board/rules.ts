import { SCRUM_CLI } from '../cli-path.ts'
import { shortRepo, type Config } from '../config.ts'
import { makeFinding, type Finding, type Severity } from '../findings/types.ts'
import type { BoardItem, Snapshot } from './types.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export function label(item: { readonly repo: string; readonly number: number | null }): string {
  return `${shortRepo(item.repo)}#${item.number ?? '?'}`
}

/**
 * 直し方。スクリプトが設定されていて、既定のリポジトリの issue ならそのコマンド、それ以外は文で返す
 * (スクリプトは既定のリポジトリの番号しか受け取らない)。
 */
function fixWith(
  config: Config,
  item: { readonly repo: string; readonly number: number | null },
  script: 'setStatus' | 'setReason' | 'setAssignee',
  args: string,
  fallback: string,
): string {
  const name = config.scripts[script]
  return name !== undefined && item.repo === config.defaultRepo ? `${name} ${item.number} ${args}` : fallback
}

type ItemRule = {
  readonly rule: string
  readonly severity: Severity
  readonly applies: (item: BoardItem, config: Config, now: Date) => boolean
  readonly message: (item: BoardItem, config: Config) => string
  readonly fix: (item: BoardItem, config: Config) => string | undefined
}

const isOpenIssue = (item: BoardItem): boolean => item.kind === 'issue' && item.state === 'OPEN'
const isStopped = (item: BoardItem, config: Config): boolean =>
  item.reason !== null && item.reason !== config.reasonNone

function daysSince(date: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(`${date}T00:00:00+09:00`)) / DAY_MS)
}

const ITEM_RULES: readonly ItemRule[] = [
  {
    rule: 'B-DOING-NO-ASSIGNEE',
    severity: 'high',
    applies: (item, config) => isOpenIssue(item) && item.status === config.statuses.doing && item.assignee === null,
    message: (item) => `${label(item)} は作業中なのに担当が無い`,
    fix: (item, config) => fixWith(config, item, 'setAssignee', '<担当>', '担当を付けるか、決められないならバックログに戻す'),
  },
  {
    rule: 'B-CLOSED-NOT-DONE',
    severity: 'medium',
    applies: (item, config) => item.kind === 'issue' && item.state === 'CLOSED' && item.status !== config.statuses.done,
    message: (item) => `${label(item)} は閉じているのに Status が ${item.status ?? '空'}`,
    fix: (item, config) => fixWith(config, item, 'setStatus', config.statuses.done, `Status を ${config.statuses.done} にする`),
  },
  {
    rule: 'B-OPEN-DONE',
    severity: 'medium',
    applies: (item, config) => isOpenIssue(item) && item.status === config.statuses.done,
    message: (item) => `${label(item)} は開いているのに完了`,
    fix: () => '閉じるか、作業中かバックログに戻す',
  },
  {
    rule: 'B-PR-STATUS',
    severity: 'medium',
    applies: (item) => item.kind === 'pr' && item.status !== null,
    message: (item) => `PR ${label(item)} に Status (${item.status}) が付いている。PR には Status を付けない`,
    fix: (item, config) =>
      `gh project item-edit --project-id ${config.projectId} --id ${item.itemId} --field-id ${config.statusFieldId} --clear`,
  },
  {
    rule: 'B-NO-STATUS',
    severity: 'medium',
    applies: (item) => isOpenIssue(item) && item.status === null,
    message: (item) => `${label(item)} に Status が無い`,
    fix: (item, config) => fixWith(config, item, 'setStatus', config.statuses.backlog, `Status を ${config.statuses.backlog} にする`),
  },
  {
    rule: 'B-NEXT-BLOCKED',
    severity: 'medium',
    applies: (item, config) => isOpenIssue(item) && item.status === config.statuses.next && isStopped(item, config),
    message: (item) => `${label(item)} は止まっている (${item.reason}) のに次にやる`,
    fix: (item, config) => fixWith(config, item, 'setStatus', config.statuses.backlog, `Status を ${config.statuses.backlog} にする`),
  },
  {
    rule: 'B-JUDGE-OWNER',
    severity: 'medium',
    applies: (item, config) =>
      isOpenIssue(item) && item.reason === config.reasonJudge && item.owner !== config.ownerUser,
    message: (item, config) =>
      `${label(item)} は${config.reasonJudge}なのに Owner が ${item.owner ?? '空'} (${config.ownerLabel} のビューに出ない)`,
    fix: (_item, config) => `Owner を ${config.ownerUser} にする`,
  },
  {
    rule: 'B-SINCE-MISSING',
    severity: 'medium',
    applies: (item, config) => isOpenIssue(item) && isStopped(item, config) && item.since === null,
    message: (item) => `${label(item)} は止まっている (${item.reason}) のに止まり始めた日が無い`,
    fix: (item, config) => fixWith(config, item, 'setReason', `${item.reason} <YYYY-MM-DD>`, '止まり始めた日を入れる'),
  },
  {
    rule: 'B-REASON-MISSING',
    severity: 'low',
    applies: (item) => isOpenIssue(item) && item.reason === null,
    message: (item) => `${label(item)} に止まっている理由が無い`,
    fix: (item, config) => fixWith(config, item, 'setReason', config.reasonNone, `止まっている理由を ${config.reasonNone} にする`),
  },
  {
    rule: 'B-SINCE-STRAY',
    severity: 'low',
    applies: (item, config) => isOpenIssue(item) && item.reason === config.reasonNone && item.since !== null,
    message: (item) => `${label(item)} は止まっていないのに止まり始めた日 (${item.since}) が残っている`,
    fix: (item, config) => fixWith(config, item, 'setReason', config.reasonNone, '止まり始めた日を消す'),
  },
  {
    rule: 'B-BLOCK-STALE',
    severity: 'low',
    applies: (item, config, now) =>
      isOpenIssue(item) &&
      isStopped(item, config) &&
      item.since !== null &&
      daysSince(item.since, now) > config.staleBlockDays,
    message: (item) => `${label(item)} は ${item.since} から止まっている (${item.reason})。見直す`,
    fix: () => '待つ先を確かめ、見込みが無ければバックログに戻す',
  },
]

function lintItem(item: BoardItem, config: Config, now: Date): readonly Finding[] {
  return ITEM_RULES.filter((rule) => rule.applies(item, config, now)).map((rule) =>
    makeFinding({
      rule: rule.rule,
      subject: label(item),
      severity: rule.severity,
      message: rule.message(item, config),
      fix: rule.fix(item, config),
    }),
  )
}

function lintWip(items: readonly BoardItem[], config: Config): readonly Finding[] {
  const doing = items.filter((item) => isOpenIssue(item) && item.status === config.statuses.doing)
  if (doing.length <= config.wipLimit) return []
  return [
    makeFinding({
      rule: 'B-WIP-OVER',
      subject: 'board',
      severity: 'high',
      message: `作業中が ${doing.length} 件で上限 ${config.wipLimit} を超えている: ${doing.map(label).join(' ')}`,
      fix: '止まっているものから見直し、見込みが無いものをバックログに戻す',
    }),
  ]
}

function lintOffBoard(snapshot: Snapshot, config: Config): readonly Finding[] {
  const onBoard = new Set(snapshot.items.map(label))
  return snapshot.openIssues
    .filter((open) => !config.excludeAuthors.includes(open.author ?? ''))
    .filter((open) => !onBoard.has(label(open)))
    .map((open) =>
      makeFinding({
        rule: 'B-OFF-BOARD',
        subject: label(open),
        severity: 'medium',
        message: `${label(open)} は開いているのにボードに無い`,
        fix: fixWith(config, open, 'setStatus', config.statuses.backlog, `ボードに足し、Status を ${config.statuses.backlog} にする`),
      }),
    )
}

const isUnreadable = (item: BoardItem): boolean => item.kind !== 'draft' && item.number === null

function unreadableFinding(count: number): Finding {
  return makeFinding({
    rule: 'B-UNREADABLE',
    subject: 'board',
    severity: 'medium',
    message: `ボードの ${count} 項目で issue・PR の中身 (番号) が読めない。取得の不具合か権限の疑い。ボードに無い issue (B-OFF-BOARD) の判定を止めている`,
    fix: `${SCRUM_CLI} refresh で取り直す。続くなら ~/.claude/scrum/log/ の fetch-failed-* と errors.log を見る`,
  })
}

/**
 * 中身の読めない項目があると、どの issue がボードにあるかを判じられない。そのときは B-OFF-BOARD を出さず、
 * 読めないことを1件の指摘にする。
 */
export function lintBoard(snapshot: Snapshot, config: Config, now: Date): readonly Finding[] {
  const items = snapshot.items.filter((item) => !config.excludeAuthors.includes(item.author ?? ''))
  const unreadable = items.filter(isUnreadable).length
  const readable = items.filter((item) => !isUnreadable(item))
  const offBoard = unreadable > 0 ? [unreadableFinding(unreadable)] : lintOffBoard(snapshot, config)
  return [...lintWip(readable, config), ...readable.flatMap((item) => lintItem(item, config, now)), ...offBoard]
}
