import { alertsOf } from '../../alerts/config.ts'
import { shortRepo, type Config } from '../../config.ts'
import { parsePriority } from '../../board/priority.ts'
import type { BoardItem, ContentState, ItemKind } from '../../board/types.ts'

/** One item of the board that GraphQL returns (ProjectV2Item). */
export type RawNode = {
  readonly id: string
  readonly type: string
  /** When the item was added to the board */
  readonly createdAt?: string | null
  readonly status?: { readonly name?: string } | null
  readonly reason?: { readonly name?: string } | null
  readonly since?: { readonly date?: string } | null
  readonly owner?: { readonly name?: string } | null
  readonly assignee?: { readonly name?: string } | null
  readonly team?: { readonly name?: string } | null
  readonly workType?: { readonly name?: string } | null
  readonly points?: { readonly number?: number } | null
  readonly priority?: { readonly name?: string } | null
  readonly overrun?: { readonly number?: number } | null
  readonly order?: { readonly number?: number } | null
  readonly content?: {
    readonly number?: number
    /** Of a pull request: when it was opened and when it was merged, and the issues it closes (the board's own item has none of these) */
    readonly createdAt?: string | null
    readonly mergedAt?: string | null
    /** Of an issue: when it was closed */
    readonly closedAt?: string | null
    readonly closingIssuesReferences?: { readonly nodes?: readonly { readonly number?: number; readonly repository?: { readonly nameWithOwner?: string } }[] } | null
    readonly title?: string
    readonly state?: string
    readonly author?: { readonly login?: string } | null
    readonly repository?: { readonly nameWithOwner?: string }
    readonly labels?: { readonly nodes?: readonly { readonly name?: string }[] } | null
    readonly parent?: { readonly number?: number; readonly repository?: { readonly nameWithOwner?: string } } | null
    readonly subIssuesSummary?: { readonly total?: number } | null
  } | null
}

const KINDS: Readonly<Record<string, ItemKind>> = { ISSUE: 'issue', PULL_REQUEST: 'pr', DRAFT_ISSUE: 'draft' }

/** The hand-over order, labels, and parent issue, fetched only when a dispatch or alerts config exists. When not fetched, the key is not added. */
function dispatchFields(node: RawNode): Partial<BoardItem> {
  const content = node.content ?? {}
  const parent = content.parent
  const subIssues = content.subIssuesSummary?.total
  return {
    ...(typeof subIssues === 'number' ? { subIssues } : {}),
    ...(node.order === undefined ? {} : { order: node.order?.number ?? null }),
    ...(content.labels === undefined ? {} : { labels: (content.labels?.nodes ?? []).flatMap((one) => (one.name === undefined ? [] : [one.name])) }),
    ...(parent === undefined
      ? {}
      : { epic: parent === null || parent.number === undefined ? null : `${shortRepo(parent.repository?.nameWithOwner ?? '')}#${parent.number}` }),
  }
}

/** When a pull request was opened and merged, and the first issue it closes. Present only for pull requests. */
function pullRequestFields(node: RawNode): Partial<BoardItem> {
  if (node.type !== 'PULL_REQUEST') return {}
  const content = node.content ?? {}
  const closes = content.closingIssuesReferences?.nodes?.find((one) => typeof one.number === 'number')
  return {
    ...(typeof content.createdAt === 'string' ? { openedAt: content.createdAt } : {}),
    ...(typeof content.mergedAt === 'string' ? { mergedAt: content.mergedAt } : {}),
    ...(closes === undefined ? {} : { closes: `${shortRepo(closes.repository?.nameWithOwner ?? '')}#${closes.number}` }),
  }
}

function normalizeNode(node: RawNode): BoardItem {
  const content = node.content ?? {}
  return {
    itemId: node.id,
    kind: KINDS[node.type] ?? 'draft',
    repo: content.repository?.nameWithOwner ?? '',
    number: content.number ?? null,
    title: content.title ?? '',
    state: (content.state as ContentState | undefined) ?? null,
    author: content.author?.login ?? null,
    status: node.status?.name ?? null,
    reason: node.reason?.name ?? null,
    since: node.since?.date ?? null,
    owner: node.owner?.name ?? null,
    assignee: node.assignee?.name ?? null,
    ...(node.team === undefined ? {} : { team: node.team?.name ?? null }),
    ...(node.workType === undefined ? {} : { workType: node.workType?.name ?? null }),
    ...(node.priority === undefined ? {} : { priority: parsePriority(node.priority?.name) }),
    points: node.points?.number ?? null,
    overrun: node.overrun?.number ?? null,
    ...(typeof node.createdAt === 'string' ? { addedAt: node.createdAt } : {}),
    ...(typeof node.content?.closedAt === 'string' ? { closedAt: node.content.closedAt } : {}),
    ...pullRequestFields(node),
    ...dispatchFields(node),
  }
}

export function normalizeNodes(nodes: readonly RawNode[]): readonly BoardItem[] {
  return nodes.map(normalizeNode)
}

function sprintFields(config: Config): string {
  const sprint = config.sprint
  const number = (alias: string, field: string) =>
    `${alias}: fieldValueByName(name:"${field}"){ ... on ProjectV2ItemFieldNumberValue{ number } }`
  // without a sprint section, the points are read when `fields.points` names the field (for `scrum forecast`)
  if (sprint === undefined) return config.fields.points === undefined ? '' : number('points', config.fields.points)
  return [number('points', sprint.pointsField), ...(sprint.overrunField === undefined ? [] : [number('overrun', sprint.overrunField)])].join(' ')
}

/** Fetches the hand-over order field only when dispatch is used. */
function dispatchItemFields(config: Config): string {
  const field = config.dispatch?.enabled === true ? config.dispatch.orderField : undefined
  return field === undefined ? '' : `order: fieldValueByName(name:"${field}"){ ... on ProjectV2ItemFieldNumberValue{ number } }`
}

/**
 * The fields read for one board item (ProjectV2Item). The query that counts the whole board (itemsQuery) and the query that reads items one by one
 * (off-board.ts) read the same fields, so they are placed in one spot here.
 */
export function itemNodeSelection(config: Config): string {
  const single = (alias: string, field: string) =>
    `${alias}: fieldValueByName(name:"${field}"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }`
  const content = 'number title state author{login} repository{nameWithOwner}'
  const issueContent = `${content} closedAt`
  const wantsFamily = config.dispatch?.enabled === true || alertsOf(config).enabled || config.runtime?.activity === true
  // The sub-issues are read from github.com always, since the In Progress limit leaves epics out; another host (an older GitHub Enterprise Server may lack the field) only when a config already reads the parent
  const subIssues = wantsFamily || config.host === undefined ? ' subIssuesSummary{ total }' : ''
  // The parent is one object, not a list, so it adds no points to a read; it is asked on github.com always (the tickets op needs every item's epic), elsewhere when a config reads it
  const parent = wantsFamily || config.host === undefined ? ' parent{ number repository{ nameWithOwner } }' : ''
  const issueExtra = `${wantsFamily ? ' labels(first:20){ nodes{ name } }' : ''}${parent}${subIssues}`
  return `id type createdAt
    ${single('status', config.fields.status)} ${single('reason', config.fields.reason)}
    ${single('owner', config.fields.owner)} ${single('assignee', config.fields.assignee)}
    ${single('priority', config.fields.priority ?? 'Priority')}
    ${config.team === undefined ? '' : single('team', config.team.field)} ${config.fields.workType === undefined ? '' : single('workType', config.fields.workType)}
    since: fieldValueByName(name:"${config.fields.since}"){ ... on ProjectV2ItemFieldDateValue{ date } }
    ${sprintFields(config)} ${dispatchItemFields(config)}
    content{ ... on Issue{ ${issueContent}${issueExtra} } ... on PullRequest{ ${content} createdAt mergedAt closingIssuesReferences(first:3){ nodes{ number repository{ nameWithOwner } } } } ... on DraftIssue{ title } }`
}
