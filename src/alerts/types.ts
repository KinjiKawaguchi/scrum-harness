import type { Finding } from '../findings/types.ts'

/** State that stall detection remembers across watch processes. */
export type AlertState = {
  /** An Epic with nobody working on it ("<repository name>#number") and the time it was first seen */
  readonly epics: Readonly<Record<string, string>>
  /** A member with no issue to hand over and the time it was first seen */
  readonly empty: Readonly<Record<string, string>>
  /** Fingerprints of notifications for which a macOS notification was shown */
  readonly desktopSent: readonly string[]
  /** Fingerprints of notifications sent to the liaison */
  readonly liaisonSent: readonly string[]
  /** Per Epic, the time the owner was last notified of E-STALL. Used so that the same Epic is not notified repeatedly */
  readonly ownerPushedAt: Readonly<Record<string, string>>
}

export const EMPTY_ALERT_STATE: AlertState = { epics: {}, empty: {}, desktopSent: [], liaisonSent: [], ownerPushedAt: {} }

/**
 * Notifications to the liaison and the owner. key is a fingerprint that tells whether it is the same notification, and once shown, the same key is not shown again.
 * owner comes with a PushNotification and a macOS notification to the owner. idle-line (a free member) and info (a notification decided not to be
 * sent to the owner) are one line only for the liaison to read.
 */
export type Notice = {
  readonly key: string
  readonly kind: 'idle-line' | 'owner' | 'info'
  /** The body sent to the liaison (includes the text sent to the owner as is) */
  readonly text: string
  /** The macOS notification (silent). If absent, none is shown */
  readonly desktop?: { readonly title: string; readonly body: string }
  /** A mark for limiting notifications to the owner about the same target (Epic, member) to once per minutes. detail is what the liaison is made to read when it is not sent */
  readonly throttle?: { readonly key: string; readonly head: string; readonly detail: string; readonly minutes: number }
  /** The fingerprints of the combined notification when notifications from one evaluation were combined into one (if none, only this notification's key). The mark for what was shown remembers all the combined items */
  readonly members?: readonly string[]
  /** A one-line description of one notification to the owner, and the target to attach a question to. Used to line up the lines when combining */
  readonly owner?: { readonly line: string; readonly waiting: readonly string[] }
}

/** The TechLead's findings and the owner's notifications, built from the same material. The notification's key is the same as the finding's key. */
export type AlertEvaluation = { readonly findings: readonly Finding[]; readonly owner: readonly Notice[] }
