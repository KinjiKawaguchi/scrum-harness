import type { BoardItem } from '../../board/types.ts'
import { dispatchOf, type Config } from '../../config.ts'
import type { LinkedBranch } from '../../ports/index.ts'
import type { GhRun } from './gh.ts'

export function branchName(prefix: string, number: number): string {
  return `${prefix}/${number}`
}

const QUERY = `query($owner:String!, $name:String!, $number:Int!, $ref:String!){
  repository(owner:$owner, name:$name){ id issue(number:$number){ id linkedBranches(first:10){ nodes{ ref{ name } } } } ref(qualifiedName:$ref){ target{ oid } } } }`
const MUTATION = `mutation($issue:ID!, $oid:GitObjectID!, $name:String!, $repo:ID!){
  createLinkedBranch(input:{issueId:$issue, oid:$oid, name:$name, repositoryId:$repo}){ linkedBranch{ ref{ name } } } }`

type Lookup = { readonly repositoryId: string; readonly issueId: string; readonly linked: readonly string[]; readonly oid: string }

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** 問い合わせの答えから、リポジトリと issue の ID、紐づいたブランチ、ベースの先頭を取り出す。読めなければ投げる。 */
export function parseLookup(output: string): Lookup {
  const repository = (JSON.parse(output) as { data?: { repository?: Record<string, any> | null } }).data?.repository
  if (!repository) throw new Error('cannot read the repository')
  if (!isText(repository.id)) throw new Error('cannot read the repository ID')
  if (!repository.issue || !isText(repository.issue.id)) throw new Error('the issue does not exist')
  if (!repository.ref || !isText(repository.ref.target?.oid)) throw new Error('the base branch does not exist')
  const nodes: readonly { ref?: { name?: unknown } | null }[] = repository.issue.linkedBranches?.nodes ?? []
  const linked = nodes.flatMap((node) => (isText(node.ref?.name) ? [node.ref.name] : []))
  return { repositoryId: repository.id, issueId: repository.issue.id, linked, oid: repository.ref.target.oid }
}

/**
 * issue に紐づいたブランチを用意する。すでに紐づいたブランチがあれば、それを返す (作らない)。
 * 無ければ、ベースのブランチの先頭から createLinkedBranch で作る。紐づいたブランチから出した PR は、
 * ベースが既定のブランチでなくても、issue の Development の欄に出る。
 */
export function ensureLinkedBranch(
  run: GhRun,
  input: { readonly repo: string; readonly number: number; readonly baseBranch: string; readonly prefix: string },
): LinkedBranch {
  const [owner = '', name = ''] = input.repo.split('/')
  const lookup = parseLookup(
    run(['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${input.number}`, '-f', `ref=refs/heads/${input.baseBranch}`]),
  )
  const existing = lookup.linked[0]
  if (existing !== undefined) return { name: existing, isNew: false }
  const branch = branchName(input.prefix, input.number)
  run(['api', 'graphql', '-f', `query=${MUTATION}`, '-f', `issue=${lookup.issueId}`, '-f', `oid=${lookup.oid}`, '-f', `name=${branch}`, '-f', `repo=${lookup.repositoryId}`])
  return { name: branch, isNew: true }
}

/** 設定の linkedBranchPrefix があるときだけ、渡す issue に紐づいたブランチを用意する。 */
export function linkBranchWith(run: GhRun, config: Config): (item: BoardItem) => LinkedBranch | null {
  return (item) => {
    const { linkedBranchPrefix, baseBranch } = dispatchOf(config)
    if (linkedBranchPrefix === undefined || item.number === null) return null
    return ensureLinkedBranch(run, { repo: item.repo, number: item.number, baseBranch, prefix: linkedBranchPrefix })
  }
}

/** 渡す錠の中で呼ぶので、1 回の gh を 15 秒で打ち切る (最大 2 回で 30 秒。ネットワークが詰まっても、ほかの部下への渡しを長く待たせない)。 */
export const LINK_GH_TIMEOUT_MS = 15_000
