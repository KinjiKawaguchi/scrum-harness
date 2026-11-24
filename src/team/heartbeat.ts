import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isPidAlive, readJson, writeJson, type Paths } from '../store.ts'
import type { ActivityState, SessionSignal } from './types.ts'

const THROTTLE_MS = 30_000
const HEARTBEAT_TTL_MS = 24 * 60 * 60 * 1000

type HeartbeatFile = SessionSignal & { readonly pid: number | null }

/** The next heartbeat to write. If the same state merely continues within 30 seconds, none is written (null). */
export function nextHeartbeat(
  prev: SessionSignal | null,
  sessionId: string,
  name: string,
  state: ActivityState,
  now: Date,
): SessionSignal | null {
  const at = now.toISOString()
  const isSame = prev !== null && prev.state === state && prev.name === name
  if (isSame && now.getTime() - Date.parse(prev.updatedAt) < THROTTLE_MS) return null
  return { sessionId, name, state, since: isSame ? prev.since : at, updatedAt: at, isAlive: true, nameSince: null }
}

export function writeHeartbeat(
  p: Paths,
  identity: { readonly sessionId: string; readonly name: string; readonly pid: number | null },
  state: ActivityState,
  now: Date,
): void {
  const path = join(p.heartbeats, `${identity.sessionId}.json`)
  const prev = readJson<HeartbeatFile | null>(path, null)
  const next = nextHeartbeat(prev, identity.sessionId, identity.name, state, now)
  if (next !== null) writeJson(path, { ...next, pid: identity.pid })
}

function isHeartbeatAlive(file: HeartbeatFile, now: Date): boolean {
  if (file.pid !== null) return isPidAlive(file.pid)
  return now.getTime() - Date.parse(file.updatedAt) < HEARTBEAT_TTL_MS
}

export function readHeartbeats(p: Paths, now: Date): readonly SessionSignal[] {
  let names: readonly string[]
  try {
    names = readdirSync(p.heartbeats).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const file = readJson<HeartbeatFile | null>(join(p.heartbeats, name), null)
    if (file === null) return []
    const { pid: _pid, ...signal } = file
    return [{ ...signal, isAlive: isHeartbeatAlive(file, now) }]
  })
}
