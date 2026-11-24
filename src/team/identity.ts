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
 * Decides the name of the session that called the hook (the name shown in ListAgents). If SCRUM_NAME is set, it is used.
 * If not, it looks up the session record by session_id and remembers it for only 5 minutes.
 */
export function resolveIdentity(p: Paths, sessionId: string, now: Date, config: Config, sessions: SessionDirectory): Identity | null {
  const fromEnv = process.env.SCRUM_NAME
  if (fromEnv) return { sessionId, name: fromEnv, pid: null }
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
