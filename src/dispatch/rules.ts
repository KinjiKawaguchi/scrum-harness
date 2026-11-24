import { label } from '../board/rules.ts'
import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { makeFinding, type Finding } from '../findings/types.ts'
import type { MemberState } from '../team/types.ts'
import { ignoredNudges, NUDGE_LIMIT, NUDGE_WINDOW_MS } from './decide.ts'
import { boardToken, seenKey, type SeenMap } from './progress.ts'
import type { DispatchRecord } from './types.ts'

/** The span (minutes) during which the TechLead is told about a handover. During it, if not yet told, it appears as a medium finding. */
const REPORT_MINUTES = 120

/** Collects nudges per person and per issue, within the most recent NUDGE_WINDOW_MS (oldest first). */
function nudgesByIssue(records: readonly DispatchRecord[], member: string, now: Date): ReadonlyMap<string, readonly DispatchRecord[]> {
  const nudges = records
    .filter((record) => record.kind === 'nudge' && record.member === member && now.getTime() - Date.parse(record.at) <= NUDGE_WINDOW_MS)
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return nudges.reduce((acc, record) => new Map([...acc, [record.label, [...(acc.get(record.label) ?? []), record]]]), new Map<string, readonly DispatchRecord[]>())
}

/**
 * A member who was nudged NUDGE_LIMIT times in a row while the work did not progress and is still free. Raised to the TechLead (A-NUDGE-IGNORED, medium severity).
 * Counted continuously even if the member returns to free after one short turn, or the free span changes. Whether the work progressed is compared by the marker at the time of the nudge and the current marker.
 * For the current marker, the board's marker is taken from the current board and the code host's marker from what the watch process saw last (seen), and compared with the same marker as the nudge decision.
 * The fingerprint is per the first time of the run of nudges (it is raised only once while the run continues).
 */
function lintIgnoredNudges(records: readonly DispatchRecord[], members: readonly MemberState[], now: Date, snapshot: Snapshot | null, seen: SeenMap): readonly Finding[] {
  return members.flatMap((member) => {
    if (member.state !== 'idle' || member.since === null) return []
    const minutes = Math.floor((now.getTime() - Date.parse(member.since)) / 60_000)
    return [...nudgesByIssue(records, member.name, now)].flatMap(([issue, nudges]) => {
      const item = snapshot?.items.find((one) => label(one) === issue)
      const streak = ignoredNudges(nudges, item === undefined ? undefined : { board: boardToken(item), github: seen[seenKey(member.name, issue)]?.token.github ?? null })
      const first = nudges.at(-streak)
      if (streak < NUDGE_LIMIT || first === undefined) return []
      return [
        makeFinding({
          rule: 'A-NUDGE-IGNORED',
          subject: member.name,
          keySuffix: `${issue}:${first.at}`,
          severity: 'medium',
          message: `${member.name} was nudged ${streak} times to continue ${issue}, which is In Progress, but went back to idle with no work in between (board change, PR or linked-branch activity). Idle now for ${minutes} minutes`,
          fix: `If the In Progress work is really waiting, have them set the blocked reason (then the next work is handed over). Otherwise tell ${member.name} directly`,
        }),
      ]
    })
  })
}

/**
 * From the record of work handed over, builds the "who was handed what" finding (A-DISPATCHED, medium severity) and the findings for members whose nudges do not lead to progress.
 * The hand-over was done by a machine, and nothing needs to be fixed.
 */
export function lintDispatch(
  records: readonly DispatchRecord[],
  config: Config,
  now: Date,
  members: readonly MemberState[] = [],
  snapshot: Snapshot | null = null,
  seen: SeenMap = {},
): readonly Finding[] {
  return [...lintDispatched(records, config, now), ...lintIgnoredNudges(records, members, now, snapshot, seen)]
}

function lintDispatched(records: readonly DispatchRecord[], config: Config, now: Date): readonly Finding[] {
  return records
    .filter((record) => record.kind !== 'nudge' && (now.getTime() - Date.parse(record.at)) / 60_000 <= REPORT_MINUTES)
    .map((record) =>
      makeFinding({
        rule: 'A-DISPATCHED',
        subject: record.label,
        keySuffix: record.at,
        severity: 'medium',
        message: `${record.member} was idle, so ${record.label} ${record.title} was handed over automatically (Status ${config.statuses.doing}, assignee ${record.member})`,
        fix: `If the hand-over is wrong, fix the assignee and Status and tell ${record.member}. If you do nothing, it proceeds as is`,
      }),
    )
}
