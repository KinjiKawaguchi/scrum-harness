import type { BoardItem, Snapshot } from '../src/board/types.ts'
import { DEFAULT_TUNING, type Config } from '../src/config.ts'
import { EMPTY_HISTORY, type CountingHistory } from '../src/sprint/counting-history.ts'
import type { CheckpointRecord } from '../src/sprint/record.ts'
import { NEVER_STOPPED, type TeamStop } from '../src/sprint/team-stop.ts'

export const REPO = 'example-org/app'

/** 手間を数えるときの過去の記録。何も渡さなければ、どの節目も除かない。 */
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
    status: 'バックログ',
    reason: 'なし',
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
  fields: { status: 'Status', reason: '止まっている理由', since: '止まり始めた日', owner: 'Owner', assignee: '担当' },
  statusFieldId: 'PVTSSF_status',
  statuses: { backlog: 'バックログ', next: '次にやる', doing: '作業中', release: 'リリース待ち', done: '完了' },
  reasonNone: 'なし',
  reasonJudge: '判断待ち',
  ownerUser: '@owner',
  excludeAuthors: ['external-dev'],
  techlead: 'TechLead',
  members: ['SWE1', 'SWE2', 'SWE3'],
  ownerLabel: 'オーナー',
  scripts: {
    setStatus: 'set-status',
    setReason: 'set-reason',
    setAssignee: 'set-assignee',
    bulkStatus: 'bulk-status',
    mergePr: 'merge-pr',
    clearValue: 'なし',
  },
}

export const NOW = new Date('2026-10-08T06:00:00.000Z')
