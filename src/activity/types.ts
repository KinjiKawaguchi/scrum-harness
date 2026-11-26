import type { WorkStatus } from '../agency-runtime/types.ts'

/** What the team did, for the live view: items added, Status changes, PRs opened and merged, and messages between agents. */
type Base = { readonly id: string; readonly at: string }

export type ItemAdded = Base & { readonly kind: 'itemAdded'; readonly ref: string; readonly title: string; readonly epic?: string }
export type StatusChanged = Base & { readonly kind: 'statusChanged'; readonly ref: string; readonly title: string; readonly from: WorkStatus; readonly to: WorkStatus; readonly epic?: string }
export type PrOpened = Base & { readonly kind: 'prOpened'; readonly ref: string; readonly title: string; readonly by?: string; readonly issue?: string; readonly epic?: string }
export type PrMerged = Base & { readonly kind: 'prMerged'; readonly ref: string; readonly title: string; readonly by?: string; readonly issue?: string; readonly epic?: string; readonly leadSeconds?: number }
/** `summary` is what the sender gave as the short label of the message, cut at 120 characters; it is never taken from the body. */
export type MessageSent = Base & { readonly kind: 'message'; readonly from: string; readonly to: string; readonly summary: string }

export type ActivityEvent = ItemAdded | StatusChanged | PrOpened | PrMerged | MessageSent
