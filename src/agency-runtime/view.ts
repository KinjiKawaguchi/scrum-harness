import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { OwnerRequest } from '../requests/types.ts'
import type { MemberState } from '../team/types.ts'
import { EMPTY_DONE_TIMES, type DoneTimes } from './done-at.ts'
import { epicForecasts, epicRefsOf } from './epics.ts'
import { peopleOf } from './people.ts'
import { requestsOf } from './requests.ts'
import type { TeamView } from './types.ts'
import { workItems } from './work.ts'

export type ViewInput = {
  readonly org: string
  readonly team: string
  readonly label: string
  readonly config: Config
  readonly snapshot: Snapshot
  readonly members: readonly MemberState[]
  /** The requests the team filed (see src/requests) */
  readonly stored: readonly OwnerRequest[]
  readonly now: Date
  /** When items reached done, as the refresh saw it. Without it only the tracker's own times are used */
  readonly doneTimes?: DoneTimes
}

/**
 * The team as a TeamView. `generatedAt` is when the board was read, so a client can tell that a quiet harness is stale.
 * People and requests are from the same board; the work list leaves out finished items that are closed.
 */
export function buildTeamView(input: ViewInput): TeamView {
  const { config, snapshot, members, stored, now } = input
  const doneTimes = input.doneTimes ?? EMPTY_DONE_TIMES
  const items: readonly BoardItem[] = snapshot.items
  const requests = requestsOf(items, config, snapshot.fetchedAt, stored)
  return {
    org: input.org,
    team: input.team,
    label: input.label,
    generatedAt: new Date(snapshot.fetchedAt).toISOString(),
    people: peopleOf(members, items, requests, config, now),
    requests,
    work: workItems(items, config, snapshot.fetchedAt, epicRefsOf(items), doneTimes),
    epics: epicForecasts(items, config, doneTimes, now),
  }
}
