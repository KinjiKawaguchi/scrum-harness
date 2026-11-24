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

/** From the query's answer, extracts the repository and issue IDs, the linked branch, and the base head. Throws if it cannot be read. */
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
 * Prepares the branch linked to an issue. If a linked branch already exists, returns it (does not create one).
 * If not, creates one from the head of the base branch with createLinkedBranch. A PR made from a linked branch
 * appears in the issue's Development field even when the base is not the default branch.
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

/** Only when linkedBranchPrefix is in the config, prepares a branch linked to the issue being handed over. */
export function linkBranchWith(run: GhRun, config: Config): (item: BoardItem) => LinkedBranch | null {
  return (item) => {
    const { linkedBranchPrefix, baseBranch } = dispatchOf(config)
    if (linkedBranchPrefix === undefined || item.number === null) return null
    return ensureLinkedBranch(run, { repo: item.repo, number: item.number, baseBranch, prefix: linkedBranchPrefix })
  }
}

/** Called inside the handover lock, so each gh call is cut off at 15 seconds (at most 2 calls, 30 seconds; even if the network clogs, handovers to other members are not made to wait long). */
export const LINK_GH_TIMEOUT_MS = 15_000
