import { label } from '../../board/rules.ts'
import type { BoardItem } from '../../board/types.ts'
import { shortRepo } from '../../config.ts'
import type { ItemRelations } from '../../ports/index.ts'
import type { GhRun } from './gh.ts'

/** Issues read in one query. */
const CHUNK = 40
const FIELD_LIMIT = 30
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

type Target = { readonly alias: string; readonly repo: string; readonly number: number; readonly ref: string }

/** A query that reads the labels and the issues that block each issue (GitHub's issue dependencies), with each blocker's state. The aliases are i0, i1, .... */
export function relationsQuery(targets: readonly Target[]): string {
  const parts = targets.map((target) => {
    const [owner, name] = target.repo.split('/')
    return `${target.alias}: repository(owner:"${owner}", name:"${name}"){ issue(number:${target.number}){ labels(first:${FIELD_LIMIT}){ nodes{ name } } blockedBy(first:${FIELD_LIMIT}){ nodes{ number state repository{ nameWithOwner } } } } }`
  })
  return `query{ ${parts.join(' ')} }`
}

type RawIssue = {
  readonly labels?: { readonly nodes?: readonly { readonly name?: string }[] } | null
  readonly blockedBy?: { readonly nodes?: readonly { readonly number?: number; readonly state?: string; readonly repository?: { readonly nameWithOwner?: string } }[] } | null
} | null

function parse(output: string, targets: readonly Target[]): readonly (readonly [string, ItemRelations])[] {
  const data = (JSON.parse(output) as { readonly data?: Readonly<Record<string, { readonly issue?: RawIssue } | null>> | null }).data
  if (data === undefined || data === null) throw new Error(`the result of reading the issue relations has no data: ${output.slice(0, 200)}`)
  return targets.flatMap((target): readonly (readonly [string, ItemRelations])[] => {
    const issue = data[target.alias]?.issue
    if (issue === null || issue === undefined) return []
    const labels = (issue.labels?.nodes ?? []).flatMap((one) => (typeof one.name === 'string' ? [one.name] : []))
    // Only the blockers that are still open: a closed one has done its part.
    const blockedBy = (issue.blockedBy?.nodes ?? []).flatMap((one) => (one.state === 'OPEN' && typeof one.number === 'number' ? [`${shortRepo(one.repository?.nameWithOwner ?? target.repo)}#${one.number}`] : []))
    return [[target.ref, { labels, blockedBy }]]
  })
}

/**
 * Reads the labels and the open blockers of the issues, keyed by label. An issue that cannot be read (deleted, moved) is left out, so it is "not read",
 * not "has no blocker". A repository name or number that cannot be put in a query is an error.
 */
export function relationsFor(items: readonly BoardItem[], run: GhRun): ReadonlyMap<string, ItemRelations> {
  const issues = items.filter((item) => item.kind === 'issue' && item.number !== null)
  const targets = issues.map((item, index): Target => {
    if (!REPO.test(item.repo) || !Number.isInteger(item.number) || (item.number ?? 0) < 1) throw new Error(`cannot read the relations of ${label(item)}: its repository or number cannot be put in a query`)
    return { alias: `i${index}`, repo: item.repo, number: item.number as number, ref: label(item) }
  })
  const chunks = Array.from({ length: Math.ceil(targets.length / CHUNK) }, (_, index) => targets.slice(index * CHUNK, (index + 1) * CHUNK))
  return new Map(chunks.flatMap((chunk) => parse(run(['api', 'graphql', '-f', `query=${relationsQuery(chunk)}`]), chunk)))
}
