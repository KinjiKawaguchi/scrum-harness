import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionDirectory } from '../../ports/index.ts'
import { isPidAlive, readJson } from '../../store.ts'
import type { ActivityState, SessionSignal } from '../../team/types.ts'

type SessionRecord = { readonly pid?: unknown; readonly sessionId?: unknown; readonly name?: unknown }

export function sessionsDir(): string {
  return process.env.SCRUM_SESSIONS_DIR ?? join(homedir(), '.claude', 'sessions')
}

export function findSessionName(records: readonly SessionRecord[], sessionId: string): string | null {
  const record = records.find((one) => one.sessionId === sessionId)
  return typeof record?.name === 'string' ? record.name : null
}

/** ~/.claude/sessions/<pid>.json を読む。Claude Code の内部の記録なので、読めないものは捨てる。 */
export function readSessionRecords(dir: string = sessionsDir()): readonly SessionRecord[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        const record = readJson<SessionRecord | null>(join(dir, name), null)
        return record === null ? [] : [record]
      })
  } catch {
    return []
  }
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
export function parseSessionFile(raw: unknown, isAlive: (pid: number) => boolean): SessionSignal | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const state = SESSION_STATUS[String(record.status)]
  const { pid, sessionId, name } = record
  const at = toIso(record.statusUpdatedAt)
  if (state === undefined || typeof name !== 'string' || typeof sessionId !== 'string') return null
  if (typeof pid !== 'number' || at === null) return null
  return { sessionId, name, state, since: at, updatedAt: at, isAlive: isAlive(pid), nameSince: toIso(record.nameSince) }
}

/** Claude Code のセッションの記録 (~/.claude/sessions、SCRUM_SESSIONS_DIR で変えられる) を、読むたびに読み直す。 */
export function claudeCodeSessions(): SessionDirectory {
  return {
    find: (sessionId) => {
      const records = readSessionRecords()
      const record = records.find((one) => one.sessionId === sessionId)
      return { name: findSessionName(records, sessionId), pid: typeof record?.pid === 'number' ? record.pid : null }
    },
    signals: () =>
      readSessionRecords().flatMap((record) => {
        const signal = parseSessionFile(record, isPidAlive)
        return signal === null ? [] : [signal]
      }),
  }
}
