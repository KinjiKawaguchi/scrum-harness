/**
 * A request from the team to the owner. One file per request, at <state dir>/requests/<id>.json.
 * `waiting` says whose turn it is: `owner` waits for the owner's answer, `team` means the owner answered and the team acts.
 */

/** A question may have options; a proposal always has options and may carry a Markdown document to decide on. */
export type RequestKind = 'question' | 'proposal'

export type RequestOption = {
  readonly key: string
  readonly text: string
  readonly isRecommended?: boolean
  /** What choosing the option changes (cost, people, scope). Plain text. */
  readonly detail?: string
}

export type RequestMessage = {
  /** `owner`, or the name of a team session */
  readonly from: string
  readonly text: string
  /** The key of the chosen option (the owner's answers only) */
  readonly choice?: string
  /** The id of the member who decided. Set only by a verified decision; a message from the owner without it is not the owner's. */
  readonly by?: string
  readonly at: string
}

export type OwnerRequest = {
  readonly id: string
  readonly title: string
  /** The background needed to decide. Plain text. */
  readonly context: string
  /** The body of a proposal, in Markdown. Clients render a safe subset and never raw HTML. */
  readonly document?: string
  readonly kind: RequestKind
  /** The name of the session that filed it */
  readonly from: string
  readonly createdAt: string
  /** The related issue, `<repo>#<number>` */
  readonly issue?: string
  /** The addressee, by the harness's own name. Absent means the owner. */
  readonly to?: string
  /** The people and issues that wait for the answer */
  readonly blocks: readonly string[]
  readonly options: readonly RequestOption[]
  readonly waiting: 'owner' | 'team'
  readonly messages: readonly RequestMessage[]
  readonly closedAt?: string
  readonly closeNote?: string
}

export const OWNER = 'owner'

/** What the team view calls a message that claims to be the owner's but was not recorded by a verified decision. */
export const UNVERIFIED = 'unverified'
