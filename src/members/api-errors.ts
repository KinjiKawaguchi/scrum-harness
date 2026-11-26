import { makeFinding, type Finding } from '../findings/types.ts'
import { SCRUM_CLI } from '../cli-path.ts'
import type { SessionDirectory, TurnError } from '../ports/index.ts'
import type { SessionSignal } from '../team/types.ts'
import { baseName } from '../usage/attribution.ts'

/** An idle member's last reply has to have been an error for this long before it is reported: a turn that ended a moment ago may be retried. */
const IDLE_MINUTES = 3

/** A busy member is reported when its last replies were errors this many times in a row (it keeps "finishing" with the error whenever a message arrives). */
const BUSY_REPEATS = 2

export type MemberTurnError = TurnError & { readonly name: string }

/** The live session of a member, the latest when several answer to the name. */
function liveSignal(signals: readonly SessionSignal[], name: string): SessionSignal | undefined {
  return signals.filter((signal) => signal.isAlive && signal.state !== 'ended' && baseName(signal.name) === name).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

/**
 * The members whose session is stuck on an API error: idle for 3 minutes with the error as the last thing in the record, or busy with the error twice in a
 * row. Both look like a working member otherwise. Reads each such member's transcript tail only.
 */
export function findTurnErrors(signals: readonly SessionSignal[], sessions: SessionDirectory, names: readonly string[], now: Date): readonly MemberTurnError[] {
  const read = sessions.turnError
  if (read === undefined) return []
  return names.flatMap((name): readonly MemberTurnError[] => {
    const live = liveSignal(signals, name)
    if (live === undefined || live.state === 'waiting') return []
    const isIdleLongEnough = live.state === 'idle' && Date.parse(live.since) <= now.getTime() - IDLE_MINUTES * 60_000
    const error = live.state === 'busy' || isIdleLongEnough ? read(live.sessionId) : null
    if (error === null) return []
    const isStuck = live.state === 'busy' ? error.count >= BUSY_REPEATS : error.isLast
    return isStuck ? [{ ...error, name }] : []
  })
}

/**
 * M-API-ERROR: a member's last reply was an API error, so it is stuck although it looks idle (or flickers between busy and idle). High. It names the error and
 * the first line of its text. It goes away when the member answers (a reply that is not an error).
 */
export function lintTurnErrors(errors: readonly MemberTurnError[]): readonly Finding[] {
  return errors.map((error) =>
    makeFinding({
      rule: 'M-API-ERROR',
      subject: error.name,
      severity: 'high',
      message: `${error.name} looks ${error.isLast ? 'idle' : 'busy'}, but its last reply was an API error (${error.error}${error.count > 1 ? `, ${error.count} in a row` : ''}): ${error.text === '' ? 'no text' : error.text}`,
      fix: `Look at its window (tmux). If the context is too long, run /compact in it; otherwise restart it with ${SCRUM_CLI} member stop ${error.name}, then ${SCRUM_CLI} member start ${error.name} --resume. Check the Claude Code version it runs (${SCRUM_CLI} member list)`,
      keySuffix: error.at,
    }),
  )
}
