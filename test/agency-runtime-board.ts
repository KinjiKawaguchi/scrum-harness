import type { BoardItem, Snapshot } from '../src/board/types.ts'
import type { Config } from '../src/config.ts'
import type { SessionSignal } from '../src/team/types.ts'
import { config as base, issue, NOW } from './helpers.ts'

export const config: Config = { ...base, idleMinutes: 10, runtime: { blockedReasons: { waitingOnPrevious: 'Waiting on previous' } } }
export const statuses = config.statuses

const iso = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()

/** An epic with four children, one pending decision, one block that is not a decision, and noise that must be left out. */
export const items: readonly BoardItem[] = [
  issue(100, { title: 'Persistent sessions', status: statuses.doing }),
  issue(12, { title: 'Store sessions', status: statuses.doing, tanto: 'SWE1', epic: 'app#100', points: 3 }),
  issue(14, { title: 'Drop the old export?', status: statuses.next, reason: config.reasonJudge, since: '2026-10-07', epic: 'app#100', points: 2 }),
  issue(15, { title: 'Document the store', tanto: 'SWE2', reason: 'Waiting on previous', since: '2026-10-08', epic: 'app#100' }),
  issue(8, { title: 'Set up the project', status: statuses.done, state: 'CLOSED', epic: 'app#100' }),
  issue(11, { title: 'Add a health check', status: statuses.release, tanto: 'SWE1', points: 1 }),
  issue(16, { title: 'Odd points', points: 2.5, reason: 'Some other reason', since: 'not a date' }),
  issue(17, { title: 'Outside contributor', author: 'external-dev' }),
  issue(18, { title: 'Unknown status', status: 'Triage' }),
]

export const board = (fetchedAt: Date = NOW): Snapshot => ({ fetchedAt: fetchedAt.toISOString(), items, openIssues: [] })

const signal = (name: string, state: SessionSignal['state'], minutesAgo: number): SessionSignal => ({
  sessionId: `session-${name}`,
  name,
  state,
  since: iso(minutesAgo),
  updatedAt: iso(minutesAgo),
  isAlive: true,
  nameSince: iso(600),
})

/** The lead is working, SWE1 waits on a permission prompt, SWE2 has been idle for 30 minutes, SWE3 has no session. */
export const sessions: readonly SessionSignal[] = [signal('TechLead', 'busy', 5), signal('SWE1', 'waiting', 3), signal('SWE2', 'idle', 30)]
