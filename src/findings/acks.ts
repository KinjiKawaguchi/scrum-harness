import type { Finding } from './types.ts'

/** 意図した例外として、期限まで指摘を黙らせる記録。一覧はスプリントレビューに出す。 */
export type Ack = {
  readonly rule: string
  readonly subject: string
  readonly until: string
  readonly reason: string
  readonly at: string
  /** 「枠 HH:MM」の受け入れの、枠の始まり (ISO 8601)。自動で渡すのは、この 15 分前から止める */
  readonly slotAt?: string
  /** S-POINTS-OVER の受け入れの根拠 (超過の扱いを決めた印の中身と、そのコメントの URL)。無ければ、その受け入れは指摘を消さない */
  readonly basis?: string
}

/** S-POINTS-OVER は、超過の扱いを決めた記録 (basis) が付いた受け入れだけが、指摘を消す。記録の無い古い受け入れは、期限内でも指摘を消さない。 */
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
