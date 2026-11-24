import type { Config } from '../config.ts'

/**
 * Stall detection (E-STALL, Q-EMPTY) and notifications to the liaison and the owner. If it is absent or enabled is not true, it does not run.
 * The harness decides what to tell, whom, and when. The liaison session only acts as the hand that sends the fixed text.
 */
export type AlertsConfig = {
  readonly enabled: boolean
  /** Name of the liaison session. The session with this name watches and receives the notification text the harness decided */
  readonly liaison?: string
  /** Minutes before an Epic with nobody working on it is raised as E-STALL */
  readonly epicStallMinutes: number
  /** Minutes before a member with no issue to hand over is also reported to the owner */
  readonly emptyEscalateMinutes: number
  /** Whether the harness shows a macOS notification (silent) directly. So that it reaches the owner even while the liaison is working */
  readonly isDesktopEnabled: boolean
  /** An Epic with a label of this name is parked on purpose, so it is not counted as E-STALL (the TechLead attaches the label) */
  readonly parkedLabels: readonly string[]
  /** Lower bound (minutes) on the interval for notifying the owner of the E-STALL of the same Epic. The TechLead and the liaison are told regardless of this interval */
  readonly epicPushMinutes: number
  /** Lower bound (minutes) on the interval for notifying the owner about the same member with no issue to hand over (Q-EMPTY-OWNER) */
  readonly emptyPushMinutes: number
}

export const DEFAULT_ALERTS: AlertsConfig = {
  enabled: false,
  epicStallMinutes: 60,
  emptyEscalateMinutes: 30,
  isDesktopEnabled: true,
  parkedLabels: ['epic:parked'],
  epicPushMinutes: 24 * 60,
  emptyPushMinutes: 60,
}

export function alertsOf(config: Config): AlertsConfig {
  return config.alerts ?? DEFAULT_ALERTS
}

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((one) => typeof one === 'string')
const isPositiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** Reads the alerts config. If the shape differs, only this feature is stopped (undefined). Missing items are filled with defaults. */
export function parseAlerts(raw: unknown): AlertsConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { enabled, liaison, epicStallMinutes, emptyEscalateMinutes, isDesktopEnabled, parkedLabels, epicPushMinutes, emptyPushMinutes } = raw as Record<string, unknown>
  const isValid =
    typeof enabled === 'boolean' &&
    (liaison === undefined || (typeof liaison === 'string' && liaison !== '')) &&
    (epicStallMinutes === undefined || isPositiveNumber(epicStallMinutes)) &&
    (emptyEscalateMinutes === undefined || isPositiveNumber(emptyEscalateMinutes)) &&
    (isDesktopEnabled === undefined || typeof isDesktopEnabled === 'boolean') &&
    (parkedLabels === undefined || isStringList(parkedLabels)) &&
    (epicPushMinutes === undefined || isPositiveNumber(epicPushMinutes)) &&
    (emptyPushMinutes === undefined || isPositiveNumber(emptyPushMinutes))
  if (!isValid) return undefined
  return {
    enabled,
    ...(liaison === undefined ? {} : { liaison: liaison as string }),
    epicStallMinutes: (epicStallMinutes as number | undefined) ?? DEFAULT_ALERTS.epicStallMinutes,
    emptyEscalateMinutes: (emptyEscalateMinutes as number | undefined) ?? DEFAULT_ALERTS.emptyEscalateMinutes,
    isDesktopEnabled: (isDesktopEnabled as boolean | undefined) ?? DEFAULT_ALERTS.isDesktopEnabled,
    parkedLabels: (parkedLabels as readonly string[] | undefined) ?? DEFAULT_ALERTS.parkedLabels,
    epicPushMinutes: (epicPushMinutes as number | undefined) ?? DEFAULT_ALERTS.epicPushMinutes,
    emptyPushMinutes: (emptyPushMinutes as number | undefined) ?? DEFAULT_ALERTS.emptyPushMinutes,
  }
}
