import type { ProgressToken } from './progress.ts'

/**
 * A record of work handed to a free member. Kept one line per item, in the order handed over.
 * An item whose kind is nudge is a record of nudging them to advance their own In Progress issue rather than a new issue (dispatch if absent).
 */
export type DispatchRecord = {
  readonly kind?: 'dispatch' | 'nudge'
  readonly at: string
  readonly member: string
  /** "<repository name>#number" */
  readonly label: string
  readonly title: string
  /** The branch linked to the issue at handover (only when it was prepared) */
  readonly branch?: string
  /** The issue's work marker at the time the nudge was sent. Before the next nudge, it is compared with this to see whether the work progressed (attached only to nudges) */
  readonly progress?: ProgressToken
}
