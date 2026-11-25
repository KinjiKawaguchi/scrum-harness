import type { AlertsConfig } from '../src/alerts/config.ts'
import { EMPTY_ALERT_STATE, type AlertState } from '../src/alerts/types.ts'
import type { BoardItem } from '../src/board/types.ts'
import type { Config } from '../src/config.ts'
import type { MemberState } from '../src/team/types.ts'
import { config, issue, NOW } from './helpers.ts'

export const alerts: AlertsConfig = { enabled: true, liaison: 'Liaison', epicStallMinutes: 60, emptyEscalateMinutes: 30, isDesktopEnabled: true, parkedLabels: ['epic:parked'], epicPushMinutes: 24 * 60, emptyPushMinutes: 60 }

/** A config with both alerts and dispatch enabled. */
export const enabled: Config = {
  ...config,
  alerts,
  dispatch: { enabled: true, baseBranch: 'develop', skipLabels: [], utcOffset: '+09:00', notes: [] },
}

export const minutesAgo = (minutes: number, from: Date = NOW): string => new Date(from.getTime() - minutes * 60_000).toISOString()
export const minutesLater = (minutes: number, from: Date = NOW): Date => new Date(from.getTime() + minutes * 60_000)

export const busy = (name: string, minutes = 5): MemberState => ({ name, state: 'busy', since: minutesAgo(minutes) })
export const idle = (name: string, minutes = 20): MemberState => ({ name, state: 'idle', since: minutesAgo(minutes) })

/** Epic app#100 (it works as a parent outside the board too, but sits on the board so that its title can be shown) and its children. */
export const epic = (overrides: Partial<BoardItem> = {}): BoardItem => issue(100, { title: 'Epic 100', ...overrides })
export const child = (number: number, overrides: Partial<BoardItem> = {}): BoardItem => issue(number, { epic: 'app#100', ...overrides })

export const stateWith = (overrides: Partial<AlertState>): AlertState => ({ ...EMPTY_ALERT_STATE, ...overrides })
