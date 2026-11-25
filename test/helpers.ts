import type { BoardItem, Snapshot } from '../src/board/types.ts'
import { DEFAULT_TUNING, type Config } from '../src/config.ts'
import { EMPTY_HISTORY, type CountingHistory } from '../src/sprint/counting-history.ts'
import type { CheckpointRecord } from '../src/sprint/record.ts'
import { NEVER_STOPPED, type TeamStop } from '../src/sprint/team-stop.ts'

export const REPO = 'example-org/app'

/** Past records used when counting effort. If none are given, no checkpoint is excluded. */
export const historyOf = (records: readonly CheckpointRecord[] = [], teamStop: TeamStop = NEVER_STOPPED): CountingHistory => ({ ...EMPTY_HISTORY, records, teamStop })

export function issue(number: number, overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    itemId: `PVTI_${number}`,
    kind: 'issue',
    repo: REPO,
    number,
    title: `issue ${number}`,
    state: 'OPEN',
    author: 'owner',
    status: 'Backlog',
    reason: 'None',
    since: null,
    owner: 'AI',
    assignee: null,
    ...overrides,
  }
}

export function pr(number: number, overrides: Partial<BoardItem> = {}): BoardItem {
  return issue(number, { kind: 'pr', state: 'MERGED', status: null, reason: null, ...overrides })
}

export function snapshot(items: readonly BoardItem[], openIssues?: Snapshot['openIssues']): Snapshot {
  return {
    fetchedAt: '2026-10-08T06:00:00.000Z',
    items,
    openIssues:
      openIssues ??
      items
        .filter((item) => item.kind === 'issue' && item.state === 'OPEN')
        .map((item) => ({ repo: item.repo, number: item.number ?? 0, author: item.author })),
  }
}

export const config: Config = {
  ...DEFAULT_TUNING,
  projectId: 'PVT_test',
  repos: ['example-org/app', 'example-org/app-mobile'],
  defaultRepo: 'example-org/app',
  fields: { status: 'Status', reason: 'Blocked reason', since: 'Blocked since', owner: 'Owner', assignee: 'Assigned to' },
  statusFieldId: 'PVTSSF_status',
  statuses: { backlog: 'Backlog', next: 'Next', doing: 'In Progress', release: 'Release', done: 'Done' },
  reasonNone: 'None',
  reasonJudge: 'Needs decision',
  ownerUser: '@owner',
  excludeAuthors: ['external-dev'],
  techlead: 'TechLead',
  members: ['SWE1', 'SWE2', 'SWE3'],
  ownerLabel: 'the owner',
  scripts: {
    setStatus: 'set-status',
    setReason: 'set-reason',
    setAssignee: 'set-assignee',
    bulkStatus: 'bulk-status',
    mergePr: 'merge-pr',
    clearValue: 'None',
  },
}

export const NOW = new Date('2026-10-08T06:00:00.000Z')
