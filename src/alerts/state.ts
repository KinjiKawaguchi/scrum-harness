import { readJson, writeJson, type Paths } from '../store.ts'
import { emptyChoices, advanceEmpty } from './empty.ts'
import { advanceEpics, epicViews } from './epic.ts'
import type { AlertInput } from './rules.ts'
import { EMPTY_ALERT_STATE, type AlertState } from './types.ts'

const isRecordOfText = (value: unknown): value is Readonly<Record<string, string>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((one) => typeof one === 'string')
const isTextList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((one) => typeof one === 'string')

/** Reads the state. If it is absent or broken, starts from a state in which nothing has been seen. */
export function readAlertState(p: Paths): AlertState {
  const raw = readJson<Partial<Record<keyof AlertState, unknown>>>(p.alertsState, {})
  return {
    epics: isRecordOfText(raw.epics) ? raw.epics : EMPTY_ALERT_STATE.epics,
    empty: isRecordOfText(raw.empty) ? raw.empty : EMPTY_ALERT_STATE.empty,
    desktopSent: isTextList(raw.desktopSent) ? raw.desktopSent : EMPTY_ALERT_STATE.desktopSent,
    liaisonSent: isTextList(raw.liaisonSent) ? raw.liaisonSent : EMPTY_ALERT_STATE.liaisonSent,
    ownerPushedAt: isRecordOfText(raw.ownerPushedAt) ? raw.ownerPushedAt : EMPTY_ALERT_STATE.ownerPushedAt,
  }
}

export function writeAlertState(p: Paths, state: AlertState): void {
  writeJson(p.alertsState, state)
}

/**
 * From the current picture, advances the time first seen for "an Epic with nobody working on it" and "a member with no issue to hand over".
 * Those that were fixed (work started, something became handable) are dropped. The fingerprints of notifications already shown are carried over as they are.
 */
export function advanceAlertState(input: AlertInput): AlertState {
  const { snapshot, members, acks, dispatches, alerts, config, now } = input
  if (snapshot === null) return alerts
  return {
    ...alerts,
    epics: advanceEpics(alerts.epics, epicViews(snapshot, members, config), now),
    empty: advanceEmpty(alerts.empty, emptyChoices(snapshot, members, acks, dispatches, config, now), now),
  }
}
