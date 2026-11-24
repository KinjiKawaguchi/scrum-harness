import { appendLine, logError, releaseLock, tryLock, type Paths } from '../store.ts'
import type { Config } from '../config.ts'
import { lintAll, loadContext } from '../findings/lint.ts'
import { alertsOf } from './config.ts'
import type { Notifier, SessionDirectory } from '../ports/index.ts'
import { idleLines } from './idle-lines.ts'
import { mergeOwner } from './merge.ts'
import { evaluateAlerts, type AlertInput } from './rules.ts'
import { advanceAlertState, writeAlertState } from './state.ts'
import { applyThrottle, newlyPushed, recordPushed } from './throttle.ts'
import { EMPTY_ALERT_STATE, type AlertState, type Notice } from './types.ts'

export type AlertOptions = {
  readonly notify: Notifier
  readonly sessions: SessionDirectory
  /** True when this is the liaison's watch process. Returns the notifications to send to the liaison and remembers the fingerprints sent */
  readonly isLiaison: boolean
}

/** Keeps only the fingerprints of notifications that exist now. A notification that arises again after being fixed is shown again. */
function prune(keys: readonly string[], current: readonly Notice[]): readonly string[] {
  const live = new Set(current.map((notice) => notice.key))
  return [...new Set(keys)].filter((key) => live.has(key)).toSorted()
}

/**
 * Among notifications to the owner, combines those not yet shown as a macOS notification into one and shows it. Even on failure, the same notification is not tried again repeatedly.
 * Returns the fingerprints of the notifications shown (attempted).
 */
function sendDesktop(p: Paths, owner: readonly Notice[], sent: readonly string[], notify: Notifier, config: Config, now: Date): readonly string[] {
  const fresh = owner.filter((notice) => notice.desktop !== undefined && !sent.includes(notice.key))
  const merged = mergeOwner(fresh, config)
  if (merged?.desktop === undefined) return []
  try {
    notify(merged.desktop.title, merged.desktop.body)
    appendLine(p.events, JSON.stringify({ at: now.toISOString(), type: 'alert-desktop', key: merged.key, count: fresh.length }))
  } catch (error) {
    logError(p, 'alert-desktop', error)
  }
  return fresh.map((notice) => notice.key)
}

type Sent = { readonly desktopKeys: readonly string[]; readonly liaisonKeys: readonly string[]; readonly ownerPushedAt: AlertState['ownerPushedAt'] }

function nextState(advanced: AlertState, notices: readonly Notice[], sent: Sent): AlertState {
  return {
    ...advanced,
    desktopSent: prune([...advanced.desktopSent, ...sent.desktopKeys], notices),
    liaisonSent: prune([...advanced.liaisonSent, ...sent.liaisonKeys], notices),
    ownerPushedAt: sent.ownerPushedAt,
  }
}

/**
 * One round of stall detection. It may be called from any watch process (TechLead, member, liaison).
 * Advances the time first seen, and shows the notification to the owner as a macOS notification if it has not been shown.
 * Only in the liaison's watch process, returns the notifications not yet sent to the liaison. If the lock cannot be taken, does nothing.
 */
export function alertStep(p: Paths, config: Config, now: Date, options: AlertOptions): readonly Notice[] {
  if (!alertsOf(config).enabled || !tryLock(p.alertsLock)) return []
  try {
    const ctx = loadContext(p, config, now, options.sessions)
    if (ctx.snapshot === null) return []
    const base: AlertInput = { ...ctx, alerts: ctx.alerts ?? EMPTY_ALERT_STATE, dispatches: ctx.dispatches ?? [] }
    const advanced = advanceAlertState(base)
    const input: AlertInput = { ...base, alerts: advanced }
    const activeKeys = new Set(lintAll({ ...ctx, alerts: advanced }).active.map((finding) => finding.key))
    const active = evaluateAlerts(input).owner.filter((notice) => activeKeys.has(notice.key))
    const notices = applyThrottle([...active, ...idleLines(input)], advanced, config, now)
    const owner = notices.filter((notice) => notice.kind === 'owner')
    const isDesktop = alertsOf(config).isDesktopEnabled
    const pushed = isDesktop || options.isLiaison ? newlyPushed(owner, advanced) : []
    const desktopKeys = isDesktop ? sendDesktop(p, owner, advanced.desktopSent, options.notify, config, now) : []
    const unsentOwner = owner.filter((notice) => !advanced.liaisonSent.includes(notice.key))
    const unsentOthers = notices.filter((notice) => notice.kind !== 'owner' && !advanced.liaisonSent.includes(notice.key))
    const mergedOwner = mergeOwner(unsentOwner, config)
    const unsent = [...(mergedOwner === null ? [] : [mergedOwner]), ...unsentOthers]
    const liaisonKeys = options.isLiaison ? [...unsentOwner, ...unsentOthers].map((notice) => notice.key) : []
    writeAlertState(p, nextState(advanced, notices, { desktopKeys, liaisonKeys, ownerPushedAt: recordPushed(advanced, pushed, config, now) }))
    unsent.forEach((notice) => options.isLiaison && appendLine(p.events, JSON.stringify({ at: now.toISOString(), type: 'alert-liaison', key: notice.key, kind: notice.kind })))
    return options.isLiaison ? unsent : []
  } catch (error) {
    logError(p, 'alerts', error)
    return []
  } finally {
    releaseLock(p.alertsLock)
  }
}
