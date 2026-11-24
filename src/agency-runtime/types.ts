/**
 * The wire types of Agency's TeamView and agency-runtime/1, written from the specification in
 * Agency's docs/protocol.md. The generated TypeScript types live in Agency's bindings/; contract/agency.lock
 * pins the version these types follow, and `pnpm run check:agency` reports when Agency has moved on.
 */

export const RUNTIME_VERSION = 'agency-runtime/1'

/** An RFC 3339 time in UTC, for example `2026-11-24T12:00:00Z`. */
export type Timestamp = string
/** A calendar date, `YYYY-MM-DD`. */
export type CalendarDate = string

export type PersonKind = 'agent' | 'human'
export type PersonRole = 'lead' | 'member'
export type PersonState = 'working' | 'idle' | 'away' | 'unknown'
export type WaitingOn = { readonly kind: 'person'; readonly person: string } | { readonly kind: 'lead' }

export type PersonStatus = {
  readonly id: string
  readonly label: string
  readonly kind: PersonKind
  readonly role: PersonRole
  readonly state: PersonState
  readonly since?: Timestamp
  readonly waitingOn?: WaitingOn
  readonly status: string
  readonly holding: readonly string[]
}

export type EnvelopeKind = 'answer' | 'judge'
export type RequestKind = 'question' | 'proposal' | 'pendingDecision'
export type RequestOption = { readonly key: string; readonly text: string; readonly isRecommended: boolean; readonly detail?: string }
export type ThreadMessage = { readonly from: string; readonly text: string; readonly choice?: string; readonly at: Timestamp }

export type Request = {
  readonly id: string
  readonly kind: RequestKind
  readonly title: string
  readonly context: string
  readonly document?: string
  readonly from: string
  readonly to?: string
  readonly createdAt: Timestamp
  readonly issue?: string
  readonly blocks: readonly string[]
  readonly options: readonly RequestOption[]
  readonly thread?: readonly ThreadMessage[]
  readonly answerWith: { readonly kind: EnvelopeKind; readonly target: string }
}

export type BlockedReason = 'needsDecision' | 'external' | 'waitingOnPrevious' | 'timeOrEquipment'
export type WorkStatus = 'backlog' | 'next' | 'inProgress' | 'release' | 'done'

export type WorkItem = {
  readonly ref: string
  readonly title: string
  readonly status: WorkStatus
  readonly assignee?: string
  readonly blocked?: { readonly reason: BlockedReason; readonly since: CalendarDate }
  readonly epic?: string
  readonly points?: number
  readonly eta?: { readonly p50: Timestamp; readonly p80: Timestamp; readonly basis: string; readonly isOverBudget: boolean }
}

export type EpicForecast = {
  readonly ref: string
  readonly title: string
  readonly total: number
  readonly done: number
  readonly doing: number
  readonly remainingPoints: number
  readonly blocked: readonly { readonly reason: BlockedReason; readonly count: number }[]
  readonly forecast?: { readonly days: number; readonly at: Timestamp }
  readonly basis: string
}

export type TeamView = {
  readonly org: string
  readonly team: string
  readonly label: string
  readonly generatedAt: Timestamp
  readonly people: readonly PersonStatus[]
  readonly requests: readonly Request[]
  readonly work: readonly WorkItem[]
  readonly epics: readonly EpicForecast[]
}

export type RuntimeDecision = {
  readonly kind: EnvelopeKind
  readonly target: string
  readonly by: string
  readonly payload: { readonly text: string; readonly choice?: string }
}

export type RuntimeCall =
  | { readonly op: 'describe' }
  | { readonly op: 'view' }
  | { readonly op: 'decide'; readonly decision: RuntimeDecision }

/** One request, as the node writes it to stdin. */
export type RuntimeRequest = { readonly runtime: string; readonly org: string; readonly team: string } & RuntimeCall

export type Describe = { readonly runtimes: readonly string[]; readonly ops: readonly string[]; readonly label: string }

export type RuntimeError = { readonly status: number; readonly message: string }
export type RuntimeResponse<T> = { readonly result: T } | { readonly error: RuntimeError }
