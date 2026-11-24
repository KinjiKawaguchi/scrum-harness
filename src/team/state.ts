import type { MemberState, SessionSignal } from './types.ts'

/** Merges signals of the same session into one. For the state, the more recently updated one; for the time the name was taken, whichever has it. */
function latestPerSession(signals: readonly SessionSignal[]): readonly SessionSignal[] {
  const latest = signals.reduce<ReadonlyMap<string, SessionSignal>>((acc, signal) => {
    const current = acc.get(signal.sessionId)
    if (current === undefined) return new Map([...acc, [signal.sessionId, signal]])
    const newer = current.updatedAt >= signal.updatedAt ? current : signal
    const nameSince = current.nameSince ?? signal.nameSince
    return new Map([...acc, [signal.sessionId, { ...newer, nameSince }]])
  }, new Map())
  return [...latest.values()]
}

function canonical(sessions: readonly SessionSignal[]): SessionSignal | undefined {
  const key = (signal: SessionSignal) => `${signal.nameSince ?? ''}\t${signal.updatedAt}`
  return sessions.toSorted((a, b) => key(b).localeCompare(key(a)))[0]
}

function memberState(name: string, sessions: readonly SessionSignal[]): MemberState {
  const session = canonical(sessions)
  if (session === undefined || session.state === 'ended') return { name, state: 'unknown', since: null }
  return { name, state: session.state, since: session.since }
}

/**
 * Per name, takes the state of the live session that took the name later.
 * This is because a session record left behind after moving to the background can remain with its state stuck.
 */
export function aggregateMembers(signals: readonly SessionSignal[], names: readonly string[]): readonly MemberState[] {
  const live = latestPerSession(signals).filter((signal) => signal.isAlive && signal.state !== 'ended')
  return names.map((name) => memberState(name, live.filter((signal) => signal.name === name)))
}
