import type { MemberState, SessionSignal } from './types.ts'

/** 同じセッションの信号を1つにする。状態は更新の新しいほう、名前を取った時刻はどちらかにあるもの。 */
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
 * 名前ごとに、生きているセッションのうち名前を後から取ったものの状態を採る。
 * 背景に移したあとに残った古いセッションの記録が、状態を止めたまま残ることがあるため。
 */
export function aggregateMembers(signals: readonly SessionSignal[], names: readonly string[]): readonly MemberState[] {
  const live = latestPerSession(signals).filter((signal) => signal.isAlive && signal.state !== 'ended')
  return names.map((name) => memberState(name, live.filter((signal) => signal.name === name)))
}
