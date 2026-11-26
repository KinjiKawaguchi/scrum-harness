import { join } from 'node:path'
import { alertsOf } from '../alerts/config.ts'
import type { Config } from '../config.ts'
import type { SessionDirectory } from '../ports/index.ts'
import { readJson, writeJson, type Paths } from '../store.ts'

export type Identity = { readonly sessionId: string; readonly name: string; readonly pid: number | null }

export type Role = 'techlead' | 'member' | 'liaison'

const CACHE_TTL_MS = 5 * 60 * 1000

type CachedIdentity = {
  readonly name: string | null
  readonly pid: number | null
  /** bin/scrum looks at this to decide whether to start node */
  readonly role: Role | 'none'
  readonly checkedAt: string
}

/**
 * Keeps the name `SCRUM_NAME` gives a session in the session's identity record, so that what reads the records (the token use of a Codex member, which has
 * no other record of its name) can say whose session it was. Written when there is none or the name differs; nothing is written on the calls after.
 */
function rememberName(p: Paths, sessionId: string, name: string, now: Date, config: Config): void {
  const path = join(p.identity, `${sessionId}.json`)
  if (readJson<CachedIdentity | null>(path, null)?.name === name) return
  writeJson(path, { name, pid: null, role: roleOf(name, config) ?? 'none', checkedAt: now.toISOString() } satisfies CachedIdentity)
}

/**
 * Decides the name of the session that called the hook (the name shown in ListAgents). If SCRUM_NAME is set, it is used (and kept in the session's
 * identity record). If not, it looks up the session record by session_id and remembers it for only 5 minutes.
 */
export function resolveIdentity(p: Paths, sessionId: string, now: Date, config: Config, sessions: SessionDirectory): Identity | null {
  const fromEnv = process.env.SCRUM_NAME
  if (fromEnv) {
    rememberName(p, sessionId, fromEnv, now, config)
    return { sessionId, name: fromEnv, pid: null }
  }
  const cachePath = join(p.identity, `${sessionId}.json`)
  const cached = readJson<CachedIdentity | null>(cachePath, null)
  if (cached !== null && now.getTime() - Date.parse(cached.checkedAt) < CACHE_TTL_MS) {
    return cached.name === null ? null : { sessionId, name: cached.name, pid: cached.pid }
  }
  const { name, pid } = sessions.find(sessionId)
  const role = (name === null ? null : roleOf(name, config)) ?? 'none'
  writeJson(cachePath, { name, pid, role, checkedAt: now.toISOString() } satisfies CachedIdentity)
  return name === null ? null : { sessionId, name, pid }
}

export function roleOf(name: string, config: Config): Role | null {
  if (name === config.techlead) return 'techlead'
  const alerts = alertsOf(config)
  if (alerts.enabled && alerts.liaison === name) return 'liaison'
  return config.members.includes(name) ? 'member' : null
}
