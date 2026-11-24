import type { BoardItem } from '../../board/types.ts'
import type { GhRun } from './gh.ts'

/**
 * The part of an issue's work marks that comes from GitHub: the number of issue comments, the head of the linked branch, and the number, state, and head commit of the issue's PR.
 * PRs are narrowed so that other people's PRs are not picked up: if there is a linked branch (made when work is handed over, one per issue), only PRs from that branch.
 * If there is no linked branch, only PRs whose parenthesized number in the title or leading number in the branch name matches the issue.
 */

const QUERY = `query($owner:String!, $name:String!, $number:Int!){ repository(owner:$owner, name:$name){ issue(number:$number){
  comments{ totalCount }
  linkedBranches(first:5){ nodes{ ref{ name target{ oid } } } }
  timelineItems(last:50, itemTypes:[CROSS_REFERENCED_EVENT]){ nodes{ ... on CrossReferencedEvent{ source{ ... on PullRequest{ number state headRefOid headRefName title } } } } } } } }`

type IssueActivity = {
  readonly comments?: { readonly totalCount?: unknown }
  readonly linkedBranches?: { readonly nodes?: readonly { readonly ref?: { readonly name?: unknown; readonly target?: { readonly oid?: unknown } } | null }[] }
  readonly timelineItems?: {
    readonly nodes?: readonly {
      readonly source?: { readonly number?: unknown; readonly state?: unknown; readonly headRefOid?: unknown; readonly headRefName?: unknown; readonly title?: unknown } | null
    }[]
  }
}

/** The `#N` in parentheses in a title (`feat: x (#123)`, `(#123, #124)`). */
function titleCites(title: string, number: number): boolean {
  return [...title.matchAll(/\(([^)]*)\)/g)].some((group) => [...(group[1] ?? '').matchAll(/#(\d+)\b/g)].some((one) => Number(one[1]) === number))
}

/** The leading number in a branch name (`feat/456-ci`, `456-foo`). Only when the number is followed by `-`, `_`, `/`, or the end. */
function branchStartsWith(name: string, number: number): boolean {
  const match = /^(?:[a-z]+\/)?(\d+)(?:[-_/]|$)/.exec(name)
  return match !== null && Number(match[1]) === number
}

/** Turns gh's answer into a stable, ordered string. Throws if the issue does not exist. number is the issue's number (used to narrow the PRs). */
export function activityToken(output: string, number: number | null = null): string {
  const issue = (JSON.parse(output) as { data?: { repository?: { issue?: IssueActivity | null } | null } }).data?.repository?.issue
  if (!issue) throw new Error('cannot read the issue')
  const branches = (issue.linkedBranches?.nodes ?? []).flatMap((node) => (node.ref ? [`${String(node.ref.name)}@${String(node.ref.target?.oid)}`] : []))
  const linkedNames = (issue.linkedBranches?.nodes ?? []).flatMap((node) => (node.ref && typeof node.ref.name === 'string' ? [node.ref.name] : []))
  const isOwn = (source: { readonly headRefName?: unknown; readonly title?: unknown }): boolean => {
    const branch = typeof source.headRefName === 'string' ? source.headRefName : ''
    if (linkedNames.length > 0) return linkedNames.includes(branch)
    return number !== null && (branchStartsWith(branch, number) || titleCites(typeof source.title === 'string' ? source.title : '', number))
  }
  const prs = (issue.timelineItems?.nodes ?? []).flatMap((node) => {
    const source = node.source
    return source && typeof source.number === 'number' && isOwn(source) ? [`#${source.number}:${String(source.state)}@${String(source.headRefOid)}`] : []
  })
  return JSON.stringify({ comments: issue.comments?.totalCount ?? 0, branches: branches.toSorted(), prs: prs.toSorted() })
}

export function githubProbe(run: GhRun): (item: BoardItem) => string | null {
  return (item) => {
    if (item.number === null) return null
    const [owner = '', name = ''] = item.repo.split('/')
    return activityToken(run(['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${item.number}`]), item.number)
  }
}
