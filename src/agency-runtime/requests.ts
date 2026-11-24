import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import type { Config } from '../config.ts'
import { blockedReasonOf, blockedSince } from './work.ts'
import type { Request } from './types.ts'

/** Items blocked on a decision of the owner: the open issues whose blocked reason is the configured "needs a decision" reason. */
export function pendingDecisionItems(items: readonly BoardItem[], config: Config): readonly BoardItem[] {
  return items.filter(
    (item) =>
      item.kind === 'issue' &&
      item.state === 'OPEN' &&
      !config.excludeAuthors.includes(item.author ?? '') &&
      blockedReasonOf(item, config) === 'needsDecision' &&
      item.number !== null,
  )
}

/**
 * The requests of the team. The board has one kind: an item blocked on a decision of the owner (`pendingDecision`).
 * The harness has no questions or proposals of its own. A request addressed to nobody goes to the owner.
 */
export function requestsOf(items: readonly BoardItem[], config: Config, fetchedAt: string): readonly Request[] {
  return pendingDecisionItems(items, config).map((item): Request => {
    const ref = label(item)
    const since = blockedSince(item, fetchedAt)
    return {
      id: ref,
      kind: 'pendingDecision',
      title: item.title,
      context: `Blocked on a decision since ${since}.`,
      from: 'board',
      createdAt: `${since}T00:00:00Z`,
      issue: ref,
      blocks: [ref],
      options: [],
      answerWith: { kind: 'judge', target: ref },
    }
  })
}
