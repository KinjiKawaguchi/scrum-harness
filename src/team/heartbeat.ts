import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isPidAlive, readJson, releaseLock, tryLock, writeJson, type Paths } from '../store.ts'
import { appendStateMark } from './state-log.ts'
import type { ActivityState, SessionSignal } from './types.ts'

const THROTTLE_MS = 30_000
const HEARTBEAT_TTL_MS = 24 * 60 * 60 * 1000

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

/** What the heartbeat file holds: the signal, the session's pid, and whether its state at the time of the file's first line is in the state log. */
type HeartbeatFile = SessionSignal & { readonly pid: number | null; readonly isLogged?: boolean }

const LOCK_WAIT_MS = 1000
const LOCK_POLL_MS = 20

/**
 * Runs `work` while holding the session's lock. A turn's end and the next prompt can arrive in the same second and each runs in its own process, so
 * without it both read the same file and one of them is lost. If the lock cannot be had in a second, the work runs anyway: a heartbeat is only a sign.
 */
function withSessionLock(path: string, work: () => void): void {
  const lock = `${path}.lock`
  const pause = new Int32Array(new SharedArrayBuffer(4))
  let isHeld = tryLock(lock)
  for (let waited = 0; !isHeld && waited < LOCK_WAIT_MS; waited += LOCK_POLL_MS) {
    Atomics.wait(pause, 0, 0, LOCK_POLL_MS)
    isHeld = tryLock(lock)
  }
  try {
    work()
  } finally {
    if (isHeld) releaseLock(lock)
  }
}

/**
 * Writes the heartbeat, and a line of the state log when the session's state changes. The first time the file is written after the log began (or
 * the file is new), the state it already held is logged too, with the time it began, so a member that was busy before the log existed has its time
 * from then and not only from its next change. An event older than the file (the turn's end that lost the race to the next prompt) is logged, since
 * the log is read in time order, but does not replace the newer state in the file.
 */
export function writeHeartbeat(
  p: Paths,
  identity: { readonly sessionId: string; readonly name: string; readonly pid: number | null },
  state: ActivityState,
  now: Date,
): void {
  const path = join(p.heartbeats, `${identity.sessionId}.json`)
  withSessionLock(path, () => {
    const prev = readJson<HeartbeatFile | null>(path, null)
    const isStale = prev !== null && now.getTime() < Date.parse(prev.updatedAt)
    const next = nextHeartbeat(prev, identity.sessionId, identity.name, state, now)
    const isUnlogged = prev !== null && prev.isLogged !== true
    if (next === null && !isUnlogged) return
    const mark = (at: string, name: string, markState: ActivityState) => appendStateMark(p.memberStates, { at, sessionId: identity.sessionId, name, state: markState })
    if (prev !== null && isUnlogged) mark(prev.since, prev.name, prev.state)
    const isChange = prev === null || prev.state !== state || prev.name !== identity.name
    if (next !== null && isChange) mark(next.updatedAt, identity.name, state)
    if (isStale) {
      // The newer state has no line of its own when it merely continued the file's, so say it again after the older one.
      if (prev !== null && isChange) mark(prev.updatedAt, prev.name, prev.state)
      return
    }
    writeJson(path, { ...(next ?? prev), pid: identity.pid, isLogged: true })
  })
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
    const { pid: _pid, isLogged: _isLogged, ...signal } = file
    return [{ ...signal, isAlive: isHeartbeatAlive(file, now) }]
  })
}
