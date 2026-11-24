import type { BoardItem, Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import type { MemberState } from '../team/types.ts'
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
  readonly now: Date
}

/**
 * The team as a TeamView. `generatedAt` is when the board was read, so a client can tell that a quiet harness is stale.
 * People and requests are from the same board; the work list leaves out finished items that are closed.
 */
export function buildTeamView(input: ViewInput): TeamView {
  const { config, snapshot, members, now } = input
  const items: readonly BoardItem[] = snapshot.items
  const requests = requestsOf(items, config, snapshot.fetchedAt)
  return {
    org: input.org,
    team: input.team,
    label: input.label,
    generatedAt: new Date(snapshot.fetchedAt).toISOString(),
    people: peopleOf(members, items, requests, config, now),
    requests,
    work: workItems(items, config, snapshot.fetchedAt, epicRefsOf(items)),
    epics: epicForecasts(items, config),
  }
}
