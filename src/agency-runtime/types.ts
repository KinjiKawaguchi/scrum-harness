/**
 * Agency's TeamView and agency-runtime/1 types. They are generated from Agency's Rust types and copied unchanged to ./bindings
 * (`scripts/agency-contract.sh update`); contract/agency.lock pins them, and `pnpm run check:agency` reports when Agency has moved on.
 */
export type { AnswerWith } from './bindings/AnswerWith.js'
export type { Blocked } from './bindings/Blocked.js'
export type { BlockedReason } from './bindings/BlockedReason.js'
export type { Date as CalendarDate } from './bindings/Date.js'
export type { Describe } from './bindings/Describe.js'
export type { EnvelopeKind } from './bindings/EnvelopeKind.js'
export type { EpicForecast } from './bindings/EpicForecast.js'
export type { PersonKind } from './bindings/PersonKind.js'
export type { PersonRole } from './bindings/PersonRole.js'
export type { PersonState } from './bindings/PersonState.js'
export type { PersonStatus } from './bindings/PersonStatus.js'
export type { Request } from './bindings/Request.js'
export type { RequestKind } from './bindings/RequestKind.js'
export type { RequestOption } from './bindings/RequestOption.js'
export type { RuntimeCall } from './bindings/RuntimeCall.js'
export type { RuntimeDecision } from './bindings/RuntimeDecision.js'
export type { RuntimeError } from './bindings/RuntimeError.js'
export type { RuntimeRequest } from './bindings/RuntimeRequest.js'
export type { RuntimeResponse } from './bindings/RuntimeResponse.js'
export type { TeamView } from './bindings/TeamView.js'
export type { ThreadMessage } from './bindings/ThreadMessage.js'
export type { Timestamp } from './bindings/Timestamp.js'
export type { WaitingOn } from './bindings/WaitingOn.js'
export type { WorkItem } from './bindings/WorkItem.js'
export type { OpenPullRequest } from './bindings/OpenPullRequest.js'
export type { Priority } from './bindings/Priority.js'
export type { PriorityChoice } from './bindings/PriorityChoice.js'
export type { Ticket } from './bindings/Ticket.js'
export type { Tickets } from './bindings/Tickets.js'
export type { WorkStatus } from './bindings/WorkStatus.js'

export const RUNTIME_VERSION = 'agency-runtime/1'

import type { ActivityEvent } from '../activity/types.ts'
import type { PriorityChoice } from './bindings/PriorityChoice.js'
import type { RuntimeRequest } from './bindings/RuntimeRequest.js'

/**
 * The optional op `tokenUsage` (agency#22). Agency has not generated bindings for it yet, so the shapes are written here from the
 * contract the node enforces. When the generated bindings gain it, replace these with the re-exports and run `scripts/agency-contract.sh update`.
 */
export const MAX_USAGE_DAYS = 90

export type TokenUsageRequest = { readonly runtime: string; readonly org: string; readonly team: string; readonly op: 'tokenUsage'; readonly days: number }

export type TokenUsage = {
  readonly org: string
  readonly team: string
  readonly days: number
  readonly generatedAt: string
  /** Oldest first, one entry per calendar day (in the runtime's time zone), today last. Cost in USD by person name. */
  readonly byDay: readonly { readonly date: string; readonly costUsd: Readonly<Record<string, number>> }[]
  readonly byPerson: readonly { readonly person: string; readonly costUsd: number; readonly tokens: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } }[]
}

/** What the runtime accepts: the request the generated bindings define, and the optional ops written above. */
export const MAX_ACTIVITY_LIMIT = 500

/**
 * The optional op `activity` (agency#204): what the team did since a time, for the live view. Oldest first; every `at` is strictly after `since`;
 * `truncated` is true when `limit` cut the list (the client asks again from the last `at`). Written here from the contract agreed with the node
 * and web teams until the generated bindings have it.
 */
export type ActivityRequest = { readonly runtime: string; readonly org: string; readonly team: string; readonly op: 'activity'; readonly since: string; readonly limit: number }

export type Activity = {
  readonly org: string
  readonly team: string
  readonly generatedAt: string
  readonly events: readonly ActivityEvent[]
  readonly truncated: boolean
}

/**
 * The optional op `participantMetrics`: what the runtime knows of each participant's days, and whose pull requests were whose. Written here from the
 * contract the node team published (`participantmetrics.sample.json` and "Participant metrics" in the protocol) until the generated bindings have it.
 * `utcOffsetMinutes`, when the node gives it, is the time zone to cut days in; the report says which one it used.
 */
export const MIN_UTC_OFFSET_MINUTES = -720
export const MAX_UTC_OFFSET_MINUTES = 840

export type ParticipantMetricsRequest = {
  readonly runtime: string
  readonly org: string
  readonly team: string
  readonly op: 'participantMetrics'
  readonly days: number
  readonly utcOffsetMinutes?: number
}

export type ParticipantDay = {
  /** YYYY-MM-DD in the time zone that cut the days */
  readonly date: string
  /** At least one session was working */
  readonly busySeconds: number
  /** No session was working and at least one waited for a decision of a human */
  readonly waitingSeconds: number
  /** Sessions were alive and none worked or waited */
  readonly idleSeconds: number
  /** Estimated cost in USD at API prices, as in `TokenUsage` */
  readonly costUsd: number
  readonly tokens: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }
}

export type ParticipantDays = { readonly name: string; readonly byDay: readonly ParticipantDay[] }

/** A pull request and the participant whose session made it. Only those whose author is known are listed. */
export type PullRequestAuthor = { readonly repo: string; readonly number: number; readonly by: string }

export type ParticipantMetrics = {
  readonly org: string
  readonly team: string
  readonly days: number
  readonly generatedAt: string
  readonly utcOffsetMinutes: number
  readonly participants: readonly ParticipantDays[]
  readonly pullRequests: readonly PullRequestAuthor[]
}

export type TicketsRequest = { readonly runtime: string; readonly org: string; readonly team: string; readonly op: 'tickets' }

export type PrioritizeRequest = {
  readonly runtime: string
  readonly org: string
  readonly team: string
  readonly op: 'prioritize'
  readonly target: string
  readonly priority: PriorityChoice
  readonly by: string
  readonly byParticipant?: string
}

export type RuntimeInput = RuntimeRequest | TokenUsageRequest | ActivityRequest | ParticipantMetricsRequest | TicketsRequest | PrioritizeRequest
