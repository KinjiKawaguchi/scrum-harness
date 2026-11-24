import type { Finding } from '../findings/types.ts'
import type { MemberState } from '../team/types.ts'

export type MetricsEvent =
  | { readonly at: string; readonly type: 'finding-opened'; readonly key: string; readonly rule: string; readonly subject: string; readonly severity: string }
  | { readonly at: string; readonly type: 'finding-closed'; readonly key: string; readonly rule: string; readonly subject: string; readonly minutes: number }
  | { readonly at: string; readonly type: 'member-state'; readonly name: string; readonly from: string; readonly to: string; readonly minutes: number }
  | { readonly at: string; readonly type: 'stop-blocked'; readonly keys: readonly string[] }
  | { readonly at: string; readonly type: 'woke'; readonly keys: readonly string[] }
  | { readonly at: string; readonly type: 'acked'; readonly rule: string; readonly subject: string; readonly until: string; readonly reason: string }
  /** A mark that a team session's hook writes once every 10 minutes to show it is working (bin/scrum) */
  | { readonly at: string; readonly type: 'activity'; readonly role: string }

type OpenFinding = { readonly rule: string; readonly subject: string; readonly at: string }

/** The previous observation. It remembers when findings started and the members' states, and records only the changes. */
export type MetricsState = {
  readonly open: Readonly<Record<string, OpenFinding>>
  readonly members: Readonly<Record<string, { readonly state: string; readonly at: string }>>
}

const minutesBetween = (from: string, to: Date): number => Math.round((to.getTime() - Date.parse(from)) / 60_000)

function findingEvents(prev: MetricsState, findings: readonly Finding[], now: Date) {
  const at = now.toISOString()
  const currentKeys = new Set(findings.map((finding) => finding.key))
  const opened = findings
    .filter((finding) => prev.open[finding.key] === undefined)
    .map((f): MetricsEvent => ({ at, type: 'finding-opened', key: f.key, rule: f.rule, subject: f.subject, severity: f.severity }))
  const closed = Object.entries(prev.open)
    .filter(([key]) => !currentKeys.has(key))
    .map(([key, open]): MetricsEvent => ({ at, type: 'finding-closed', key, rule: open.rule, subject: open.subject, minutes: minutesBetween(open.at, now) }))
  const open = Object.fromEntries(
    findings.map((f) => [f.key, prev.open[f.key] ?? { rule: f.rule, subject: f.subject, at }]),
  )
  return { events: [...opened, ...closed], open }
}

function memberEvents(prev: MetricsState, members: readonly MemberState[], now: Date) {
  const at = now.toISOString()
  const events = members.flatMap((member): readonly MetricsEvent[] => {
    const before = prev.members[member.name]
    if (before === undefined || before.state === member.state) return []
    return [{ at, type: 'member-state', name: member.name, from: before.state, to: member.state, minutes: minutesBetween(before.at, now) }]
  })
  const next = Object.fromEntries(
    members.map((member) => {
      const before = prev.members[member.name]
      const isSame = before !== undefined && before.state === member.state
      return [member.name, isSame ? before : { state: member.state, at }]
    }),
  )
  return { events, members: next }
}

export function transitions(
  prev: MetricsState,
  findings: readonly Finding[],
  members: readonly MemberState[],
  now: Date,
): { readonly events: readonly MetricsEvent[]; readonly next: MetricsState } {
  const f = findingEvents(prev, findings, now)
  const m = memberEvents(prev, members, now)
  return { events: [...f.events, ...m.events], next: { open: f.open, members: m.members } }
}

function sumBy<T>(rows: readonly T[], key: (row: T) => string, value: (row: T) => number): ReadonlyMap<string, number> {
  return rows.reduce((acc, row) => new Map([...acc, [key(row), (acc.get(key(row)) ?? 0) + value(row)]]), new Map<string, number>())
}

function findingLines(events: readonly MetricsEvent[]): readonly string[] {
  const closed = events.flatMap((e) => (e.type === 'finding-closed' ? [e] : []))
  const rules = [...new Set(closed.map((e) => e.rule))].toSorted()
  return rules.map((rule) => {
    const minutes = closed.filter((e) => e.rule === rule).map((e) => e.minutes)
    const mean = Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length)
    return `- ${rule}: fixed ${minutes.length}, mean ${mean} min, longest ${Math.max(...minutes)} min`
  })
}

const STATE_LABEL: Readonly<Record<string, string>> = { idle: 'idle', busy: 'busy', waiting: 'waiting for approval', unknown: 'unknown' }

function memberLines(events: readonly MetricsEvent[]): readonly string[] {
  const changes = events.flatMap((e) => (e.type === 'member-state' ? [e] : []))
  const totals = sumBy(changes, (e) => `${e.name}\t${e.from}`, (e) => e.minutes)
  const names = [...new Set(changes.map((e) => e.name))].toSorted()
  return names.map((name) => {
    const parts = ['idle', 'busy', 'waiting']
      .filter((state) => totals.has(`${name}\t${state}`))
      .map((state) => `${STATE_LABEL[state]} ${totals.get(`${name}\t${state}`)} min`)
    return `- ${name}: ${parts.join(', ')}`
  })
}

/** A summary for the sprint review. Counts only records since since. */
export function formatReport(events: readonly MetricsEvent[], since: Date): string {
  const inRange = events.filter((e) => Date.parse(e.at) >= since.getTime())
  const count = (type: MetricsEvent['type']) => inRange.filter((e) => e.type === type).length
  const acks = inRange.flatMap((e) => (e.type === 'acked' ? [`- ${e.rule} ${e.subject} (until ${e.until}): ${e.reason}`] : []))
  return [
    `scrum-harness record (since ${since.toISOString()})`,
    '## How long findings stayed open (the ones fixed)',
    ...findingLines(inRange),
    '## Member activity (counted when the state changed)',
    ...memberLines(inRange),
    '## Nudges to the TechLead',
    `- Turn endings blocked: ${count('stop-blocked')}`,
    `- Watch wake-ups: ${count('woke')}`,
    `- New findings: ${count('finding-opened')}`,
    '## Acknowledged exceptions',
    ...(acks.length > 0 ? acks : ['- none']),
  ].join('\n')
}
