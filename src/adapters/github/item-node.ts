import { alertsOf } from '../../alerts/config.ts'
import { shortRepo, type Config } from '../../config.ts'
import type { BoardItem, ContentState, ItemKind } from '../../board/types.ts'

/** One item of the board that GraphQL returns (ProjectV2Item). */
export type RawNode = {
  readonly id: string
  readonly type: string
  readonly status?: { readonly name?: string } | null
  readonly reason?: { readonly name?: string } | null
  readonly since?: { readonly date?: string } | null
  readonly owner?: { readonly name?: string } | null
  readonly assignee?: { readonly name?: string } | null
  readonly team?: { readonly name?: string } | null
  readonly points?: { readonly number?: number } | null
  readonly overrun?: { readonly number?: number } | null
  readonly order?: { readonly number?: number } | null
  readonly content?: {
    readonly number?: number
    readonly title?: string
    readonly state?: string
    readonly author?: { readonly login?: string } | null
    readonly repository?: { readonly nameWithOwner?: string }
    readonly labels?: { readonly nodes?: readonly { readonly name?: string }[] } | null
    readonly parent?: { readonly number?: number; readonly repository?: { readonly nameWithOwner?: string } } | null
  } | null
}

const KINDS: Readonly<Record<string, ItemKind>> = { ISSUE: 'issue', PULL_REQUEST: 'pr', DRAFT_ISSUE: 'draft' }

/** The hand-over order, labels, and parent issue, fetched only when a dispatch or alerts config exists. When not fetched, the key is not added. */
function dispatchFields(node: RawNode): Partial<BoardItem> {
  const content = node.content ?? {}
  const parent = content.parent
  return {
    ...(node.order === undefined ? {} : { order: node.order?.number ?? null }),
    ...(content.labels === undefined ? {} : { labels: (content.labels?.nodes ?? []).flatMap((one) => (one.name === undefined ? [] : [one.name])) }),
    ...(parent === undefined
      ? {}
      : { epic: parent === null || parent.number === undefined ? null : `${shortRepo(parent.repository?.nameWithOwner ?? '')}#${parent.number}` }),
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
    points: node.points?.number ?? null,
    overrun: node.overrun?.number ?? null,
    ...dispatchFields(node),
  }
}

export function normalizeNodes(nodes: readonly RawNode[]): readonly BoardItem[] {
  return nodes.map(normalizeNode)
}

function sprintFields(config: Config): string {
  const sprint = config.sprint
  if (sprint === undefined) return ''
  const number = (alias: string, field: string) =>
    `${alias}: fieldValueByName(name:"${field}"){ ... on ProjectV2ItemFieldNumberValue{ number } }`
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
  const issueExtra = config.dispatch?.enabled === true || alertsOf(config).enabled ? ' labels(first:20){ nodes{ name } } parent{ number repository{ nameWithOwner } }' : ''
  return `id type
    ${single('status', config.fields.status)} ${single('reason', config.fields.reason)}
    ${single('owner', config.fields.owner)} ${single('assignee', config.fields.assignee)}
    ${config.team === undefined ? '' : single('team', config.team.field)}
    since: fieldValueByName(name:"${config.fields.since}"){ ... on ProjectV2ItemFieldDateValue{ date } }
    ${sprintFields(config)} ${dispatchItemFields(config)}
    content{ ... on Issue{ ${content}${issueExtra} } ... on PullRequest{ ${content} } ... on DraftIssue{ title } }`
}
