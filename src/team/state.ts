import type { ActivityState, MemberState, SessionSignal } from './types.ts'

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

const SESSION_STATUS: Readonly<Record<string, ActivityState>> = {
  busy: 'busy',
  shell: 'busy',
  idle: 'idle',
  waiting: 'waiting',
}

const toIso = (value: unknown): string | null => (typeof value === 'number' ? new Date(value).toISOString() : null)

/**
 * ~/.claude/sessions/<pid>.json (Claude Code の内部の記録で、形式は公開されていない) を信号に変える。
 * 読めない形なら null を返し、フックの心拍だけで動くようにする。
 */
export function parseSessionFile(raw: unknown, isPidAlive: (pid: number) => boolean): SessionSignal | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const state = SESSION_STATUS[String(record.status)]
  const { pid, sessionId, name } = record
  const at = toIso(record.statusUpdatedAt)
  if (state === undefined || typeof name !== 'string' || typeof sessionId !== 'string') return null
  if (typeof pid !== 'number' || at === null) return null
  return { sessionId, name, state, since: at, updatedAt: at, isAlive: isPidAlive(pid), nameSince: toIso(record.nameSince) }
}
