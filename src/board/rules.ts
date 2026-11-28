import { SCRUM_CLI } from '../cli-path.ts'
import { shortRepo, type Config } from '../config.ts'
import { makeFinding, type Finding, type Severity } from '../findings/types.ts'
import type { BoardItem, Snapshot } from './types.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export function label(item: { readonly repo: string; readonly number: number | null; readonly ref?: string }): string {
  return item.ref ?? `${shortRepo(item.repo)}#${item.number ?? '?'}`
}

/** Whether an issue is an epic: it has sub-issues (the board's own read of them), or another item on the board names it as its parent. Nobody works on an epic itself. */
export function isEpic(item: BoardItem, items: readonly BoardItem[]): boolean {
  if ((item.subIssues ?? 0) > 0) return true
  const ref = label(item)
  return items.some((one) => one.epic === ref)
}

/**
 * How to fix it. If the script is configured and the issue is in the default repository, the command; otherwise it is returned as text
 * (the script accepts only numbers of the default repository).
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
    message: (item) => `${label(item)} is In Progress but has no assignee`,
    fix: (item, config) => fixWith(config, item, 'setAssignee', '<assignee>', 'Assign it, or move it back to Backlog if you cannot decide'),
  },
  {
    rule: 'B-NO-TEAM',
    severity: 'medium',
    applies: (item, config) => config.team?.adoptsUnassigned === true && isOpenIssue(item) && item.team === null,
    message: (item) => `${label(item)} is on the board but has no team`,
    fix: (item) => `${SCRUM_CLI} board move ${label(item)} --team <name>`,
  },
  {
    rule: 'B-CLOSED-NOT-DONE',
    severity: 'medium',
    applies: (item, config) => item.kind === 'issue' && item.state === 'CLOSED' && item.status !== config.statuses.done,
    message: (item) => `${label(item)} is closed but its Status is ${item.status ?? 'empty'}`,
    fix: (item, config) => fixWith(config, item, 'setStatus', config.statuses.done, `Set Status to ${config.statuses.done}`),
  },
  {
    rule: 'B-OPEN-DONE',
    severity: 'medium',
    applies: (item, config) => isOpenIssue(item) && item.status === config.statuses.done,
    message: (item) => `${label(item)} is open but Done`,
    fix: () => 'Close it, or move it back to In Progress or Backlog',
  },
  {
    rule: 'B-PR-STATUS',
    severity: 'medium',
    applies: (item) => item.kind === 'pr' && item.status !== null,
    message: (item) => `PR ${label(item)} has a Status (${item.status}). A PR must not have a Status`,
    fix: (item, config) =>
      `${config.host === undefined ? '' : `GH_HOST=${config.host} `}gh project item-edit --project-id ${config.projectId} --id ${item.itemId} --field-id ${config.statusFieldId} --clear`,
  },
  {
    rule: 'B-NO-STATUS',
    severity: 'medium',
    applies: (item) => isOpenIssue(item) && item.status === null,
    message: (item) => `${label(item)} has no Status`,
    fix: (item, config) => fixWith(config, item, 'setStatus', config.statuses.backlog, `Set Status to ${config.statuses.backlog}`),
  },
  {
    rule: 'B-NEXT-BLOCKED',
    severity: 'medium',
    applies: (item, config) => isOpenIssue(item) && item.status === config.statuses.next && isStopped(item, config),
    message: (item) => `${label(item)} is in Next but blocked (${item.reason})`,
    fix: (item, config) => fixWith(config, item, 'setStatus', config.statuses.backlog, `Set Status to ${config.statuses.backlog}`),
  },
  {
    rule: 'B-JUDGE-OWNER',
    severity: 'medium',
    applies: (item, config) =>
      isOpenIssue(item) && item.reason === config.reasonJudge && item.owner !== config.ownerUser,
    message: (item, config) =>
      `${label(item)} is blocked on "${config.reasonJudge}" but its Owner is ${item.owner ?? 'empty'} (it does not show in ${config.ownerLabel}'s view)`,
    fix: (_item, config) => `Set Owner to ${config.ownerUser}`,
  },
  {
    rule: 'B-SINCE-MISSING',
    severity: 'medium',
    applies: (item, config) => isOpenIssue(item) && isStopped(item, config) && item.since === null,
    message: (item) => `${label(item)} is blocked (${item.reason}) but has no blocked-since date`,
    fix: (item, config) => fixWith(config, item, 'setReason', `${item.reason} <YYYY-MM-DD>`, 'Set the date the block began'),
  },
  {
    rule: 'B-REASON-MISSING',
    severity: 'low',
    applies: (item) => isOpenIssue(item) && item.reason === null,
    message: (item) => `${label(item)} has no blocked reason`,
    fix: (item, config) => fixWith(config, item, 'setReason', config.reasonNone, `Set the blocked reason to ${config.reasonNone}`),
  },
  {
    rule: 'B-SINCE-STRAY',
    severity: 'low',
    applies: (item, config) => isOpenIssue(item) && item.reason === config.reasonNone && item.since !== null,
    message: (item) => `${label(item)} is not blocked but still has a blocked-since date (${item.since})`,
    fix: (item, config) => fixWith(config, item, 'setReason', config.reasonNone, 'Clear the blocked-since date'),
  },
  {
    rule: 'B-BLOCK-STALE',
    severity: 'low',
    applies: (item, config, now) =>
      isOpenIssue(item) &&
      isStopped(item, config) &&
      item.since !== null &&
      daysSince(item.since, now) > config.staleBlockDays,
    message: (item) => `${label(item)} has been blocked since ${item.since} (${item.reason}). Review it`,
    fix: () => 'Check what it waits for, and move it back to Backlog if there is no prospect',
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
  const doing = items.filter((item) => isOpenIssue(item) && item.status === config.statuses.doing && !isEpic(item, items))
  if (doing.length <= config.wipLimit) return []
  return [
    makeFinding({
      rule: 'B-WIP-OVER',
      subject: 'board',
      severity: 'high',
      message: `${doing.length} items are In Progress, over the limit of ${config.wipLimit}: ${doing.map(label).join(' ')}`,
      fix: 'Start with the blocked ones, and move those without a prospect back to Backlog',
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
        message: `${label(open)} is open but not on the board`,
        fix: config.team === undefined ? fixWith(config, open, 'setStatus', config.statuses.backlog, `Add it to the board and set Status to ${config.statuses.backlog}`) : `${SCRUM_CLI} board add ${label(open)}`,
      }),
    )
}

const isUnreadable = (item: BoardItem): boolean => item.kind !== 'draft' && item.number === null

function unreadableFinding(count: number): Finding {
  return makeFinding({
    rule: 'B-UNREADABLE',
    subject: 'board',
    severity: 'medium',
    message: `The content (number) of issues and PRs cannot be read for ${count} board items. A fetch problem or missing permission is suspected. The check for issues missing from the board (B-OFF-BOARD) is paused`,
    fix: `Refresh with ${SCRUM_CLI} refresh. If it continues, see fetch-failed-* and errors.log in ~/.claude/scrum/log/`,
  })
}

/**
 * If there are items whose content cannot be read, it cannot be judged which issues are on the board. In that case B-OFF-BOARD is not raised, and
 * the unreadability is made into a single finding.
 */
export function lintBoard(snapshot: Snapshot, config: Config, now: Date): readonly Finding[] {
  const items = snapshot.items.filter((item) => !config.excludeAuthors.includes(item.author ?? ''))
  const unreadable = items.filter(isUnreadable).length
  const readable = items.filter((item) => !isUnreadable(item))
  const offBoard = unreadable > 0 ? [unreadableFinding(unreadable)] : lintOffBoard(snapshot, config)
  return [...lintWip(readable, config), ...readable.flatMap((item) => lintItem(item, config, now)), ...offBoard]
}
