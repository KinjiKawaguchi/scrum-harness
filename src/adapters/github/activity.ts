import type { BoardItem } from '../../board/types.ts'
import type { GhRun } from './gh.ts'

/**
 * issue の作業の印のうち、GitHub から取る部分: issue のコメントの数、紐づいたブランチの先頭、その issue の PR の番号と状態と先頭のコミット。
 * PR は、ほかの人の PR を拾わないよう絞る: 紐づいたブランチ (仕事を渡したときに作る、issue ごとに 1 本) があれば、そのブランチから出た PR だけ。
 * 紐づいたブランチが無ければ、題の括弧の中か、ブランチ名の先頭の番号が、その issue と合う PR だけ。
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

/** 題の括弧の中の `#N` (`feat: x (#123)`、`(#123、#124)`)。 */
function titleCites(title: string, number: number): boolean {
  return [...title.matchAll(/\(([^)]*)\)/g)].some((group) => [...(group[1] ?? '').matchAll(/#(\d+)\b/g)].some((one) => Number(one[1]) === number))
}

/** ブランチ名の先頭の番号 (`feat/456-ci`、`456-foo`)。番号の後ろが `-`、`_`、`/` か終わりのときだけ。 */
function branchStartsWith(name: string, number: number): boolean {
  const match = /^(?:[a-z]+\/)?(\d+)(?:[-_/]|$)/.exec(name)
  return match !== null && Number(match[1]) === number
}

/** gh の答えを、順に並べた安定した文字列にする。issue が無ければ投げる。number は、その issue の番号 (PR を絞るのに使う)。 */
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
