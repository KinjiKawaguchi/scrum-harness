import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import type { Config } from '../config.ts'
import { authorOf, isOpen } from '../requests/model.ts'
import type { OwnerRequest } from '../requests/types.ts'
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

/** A stored request as a TeamView request. Earlier messages become the thread, oldest first. */
export function storedRequestOf(request: OwnerRequest): Request {
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    context: request.context,
    ...(request.document === undefined ? {} : { document: request.document }),
    from: request.from,
    ...(request.to === undefined ? {} : { to: request.to }),
    createdAt: new Date(request.createdAt).toISOString(),
    ...(request.issue === undefined ? {} : { issue: request.issue }),
    blocks: [...request.blocks],
    options: request.options.map((option) => ({ key: option.key, text: option.text, isRecommended: option.isRecommended === true, ...(option.detail === undefined ? {} : { detail: option.detail }) })),
    ...(request.messages.length === 0
      ? {}
      : { thread: request.messages.map((message) => ({ from: authorOf(message), text: message.text, ...(message.choice === undefined ? {} : { choice: message.choice }), at: new Date(message.at).toISOString() })) }),
    answerWith: { kind: 'answer', target: request.id },
  }
}

/** Requests waiting for the owner: the questions and proposals the team filed, newest first. An answered or closed one is not waiting. */
export function waitingRequestsOf(stored: readonly OwnerRequest[]): Request[] {
  return stored.filter((request) => isOpen(request) && request.waiting === 'owner').map(storedRequestOf)
}

/**
 * The requests of the owner: what the team filed, then the board items blocked on a decision (`pendingDecision`).
 * A request addressed to nobody goes to the owner.
 */
export function requestsOf(items: readonly BoardItem[], config: Config, fetchedAt: string, stored: readonly OwnerRequest[]): Request[] {
  const decisions = pendingDecisionItems(items, config).map((item): Request => {
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
  return [...waitingRequestsOf(stored), ...decisions]
}
