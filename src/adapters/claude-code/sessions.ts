import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionDirectory } from '../../ports/index.ts'
import { isPidAlive, readJson } from '../../store.ts'
import type { ActivityState, SessionSignal } from '../../team/types.ts'
import { claudeConfigDirs, projectsDirs, sessionsDirs } from './config-dirs.ts'
import { claudeCodeTurnError, claudeCodeVersion } from './turn-error.ts'

type SessionRecord = { readonly pid?: unknown; readonly sessionId?: unknown; readonly name?: unknown }

export function findSessionName(records: readonly SessionRecord[], sessionId: string): string | null {
  const record = records.find((one) => one.sessionId === sessionId)
  return typeof record?.name === 'string' ? record.name : null
}

/** Reads ~/.claude/sessions/<pid>.json. It is Claude Code's internal record, so anything unreadable is discarded. */
export function readSessionRecords(dir: string): readonly SessionRecord[] {
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

/** The records of every session folder, one after the other. */
export function readSessionRecordsIn(dirs: readonly string[]): readonly SessionRecord[] {
  return dirs.flatMap((dir) => readSessionRecords(dir))
}

const SESSION_STATUS: Readonly<Record<string, ActivityState>> = {
  busy: 'busy',
  shell: 'busy',
  idle: 'idle',
  waiting: 'waiting',
}

const toIso = (value: unknown): string | null => (typeof value === 'number' ? new Date(value).toISOString() : null)

/**
 * Turns ~/.claude/sessions/<pid>.json (Claude Code's internal record, whose format is not public) into a signal.
 * Returns null when the shape is unreadable, so that only the hook heartbeat drives it.
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

/** Re-reads Claude Code's session records (`sessions` in each configuration directory; SCRUM_SESSIONS_DIR replaces them with one folder) on every read. */
export function claudeCodeSessions(dirs: readonly string[] = sessionsDirs(claudeConfigDirs(undefined)), projects: readonly string[] = projectsDirs(claudeConfigDirs(undefined))): SessionDirectory {
  return {
    turnError: (sessionId) => claudeCodeTurnError(projects, sessionId),
    version: (sessionId) => claudeCodeVersion(projects, sessionId),
    find: (sessionId) => {
      const records = readSessionRecordsIn(dirs)
      const record = records.find((one) => one.sessionId === sessionId)
      return { name: findSessionName(records, sessionId), pid: typeof record?.pid === 'number' ? record.pid : null }
    },
    signals: () =>
      readSessionRecordsIn(dirs).flatMap((record) => {
        const signal = parseSessionFile(record, isPidAlive)
        return signal === null ? [] : [signal]
      }),
  }
}
