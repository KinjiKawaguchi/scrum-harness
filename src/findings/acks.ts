import type { Finding } from './types.ts'

/** A record that silences a finding until its deadline as an intentional exception. The list is shown in the sprint review. */
export type Ack = {
  readonly rule: string
  readonly subject: string
  readonly until: string
  readonly reason: string
  readonly at: string
  /** The slot start (ISO 8601) of a "slot HH:MM" acknowledgement. Automatic hand-over stops from 15 minutes before this */
  readonly slotAt?: string
  /** The basis of an S-POINTS-OVER acknowledgement (the content of the marker that decided how to handle the overrun, and the URL of its comment). If absent, that acknowledgement does not clear the finding */
  readonly basis?: string
}

/** For S-POINTS-OVER, only an acknowledgement carrying a record that decided how to handle the overrun (basis) clears the finding. An acknowledgement without a record does not clear the finding even within its deadline. */
export const OVERRUN_RULE = 'S-POINTS-OVER'

const isLive = (ack: Ack, now: Date): boolean => Date.parse(ack.until) > now.getTime() && (ack.rule !== OVERRUN_RULE || ack.basis !== undefined)

export function applyAcks(
  findings: readonly Finding[],
  acks: readonly Ack[],
  now: Date,
): { readonly active: readonly Finding[]; readonly acked: readonly Finding[] } {
  const live = acks.filter((ack) => isLive(ack, now))
  const isAcked = (finding: Finding) => live.some((ack) => ack.rule === finding.rule && ack.subject === finding.subject)
  return { active: findings.filter((f) => !isAcked(f)), acked: findings.filter(isAcked) }
}

export function addAck(acks: readonly Ack[], ack: Ack, now: Date): readonly Ack[] {
  const kept = acks.filter((one) => isLive(one, now) && !(one.rule === ack.rule && one.subject === ack.subject))
  return [...kept, ack]
}

const UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

export function parseDuration(text: string): number | null {
  const match = /^(\d+)([mhd])$/.exec(text)
  if (match === null) return null
  return Number(match[1]) * (UNIT_MS[match[2] ?? ''] ?? 0)
}
