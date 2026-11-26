import { OWNER, type OwnerRequest } from './types.ts'

/** A stretch in which a member's request waited for the owner's answer, in milliseconds since the epoch. */
export type OwnerWait = { readonly name: string; readonly from: number; readonly to: number }

/**
 * When the owner's answer came: the first message of the owner that a verified decision recorded, else, for a request the owner has answered (it is the
 * team's turn), the first message that says it is the owner's. Null while the request waits.
 */
function answeredAt(request: OwnerRequest): number | null {
  const ownerMessages = request.messages.filter((message) => message.from === OWNER)
  const first = ownerMessages.find((message) => message.by !== undefined) ?? (request.waiting === 'team' ? ownerMessages[0] : undefined)
  return first === undefined ? null : Date.parse(first.at)
}

/**
 * The time each request that is addressed to the owner waited for the answer: from the time it was filed to the owner's answer, else to the time it was
 * closed, else to now. A request addressed to another member of the team (`to`) waits for an agent, not for a person, and is not here.
 */
export function ownerWaits(requests: readonly OwnerRequest[], now: Date): readonly OwnerWait[] {
  return requests.flatMap((request): readonly OwnerWait[] => {
    if (request.to !== undefined) return []
    const from = Date.parse(request.createdAt)
    const closed = request.closedAt === undefined ? null : Date.parse(request.closedAt)
    const to = Math.min(now.getTime(), answeredAt(request) ?? closed ?? now.getTime())
    return Number.isNaN(from) || Number.isNaN(to) || to <= from ? [] : [{ name: request.from, from, to }]
  })
}
