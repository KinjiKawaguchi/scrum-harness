import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateDir } from './config.ts'

export type Paths = ReturnType<typeof paths>

/** Locations inside the state directory (~/.claude/scrum). */
export function paths(dir: string = stateDir()) {
  return {
    dir,
    snapshot: join(dir, 'cache', 'board.json'),
    /** A copy of the board copy from the last successful re-fetch. Only the re-fetch writes it (it does not change even when a hook or dispatch corrects Status and rewrites board.json) */
    fetchedSnapshot: join(dir, 'cache', 'board-fetched.json'),
    refreshLock: join(dir, 'cache', 'refresh.lock'),
    /** Patterns that decide whether bin/scrum starts node (line 1: after a tool, line 2: before a write). Built from the config */
    shellPatterns: join(dir, 'cache', 'shell-patterns'),
    /** The time a re-fetch was last attempted. Even if failures continue, it is attempted once per refreshSeconds */
    refreshAttempt: join(dir, 'cache', 'refresh-attempt.json'),
    /** What reading the agents' transcripts left behind (see usage/index-store.ts). Delete it to count again from scratch */
    usageIndex: join(dir, 'cache', 'usage-index.json'),
    /** A lock held while the transcripts are read, so that two readers do not count the same lines */
    usageLock: join(dir, 'cache', 'usage-index.lock'),
    heartbeats: join(dir, 'team'),
    identity: join(dir, 'identity'),
    acks: join(dir, 'acks.json'),
    notified: join(dir, 'notify', 'notified.json'),
    blocked: join(dir, 'notify', 'blocked.json'),
    /** A marker placed by the watch process. It tells bin/scrum that there is a finding not yet notified while the TechLead is working */
    pending: join(dir, 'notify', 'pending'),
    watchLock: join(dir, 'watch.lock'),
    events: join(dir, 'log', 'events.jsonl'),
    /** The checkpoint records (one checkpoint per line) */
    checkpoints: join(dir, 'log', 'checkpoints.jsonl'),
    /** The record of the points and the checkpoints actually taken for finished issues (one per line) */
    completions: join(dir, 'log', 'completions.jsonl'),
    checkpointLock: join(dir, 'cache', 'checkpoint.lock'),
    errors: join(dir, 'log', 'errors.log'),
    metricsState: join(dir, 'log', 'metrics-state.json'),
    /** The record of work handed to free members (one per line) */
    dispatches: join(dir, 'log', 'dispatches.jsonl'),
    /** A lock held while deciding and writing the work to hand over. So that the same issue is not handed to two people */
    dispatchLock: join(dir, 'cache', 'dispatch.lock'),
    /** Per member and per issue, the work marker last seen and the time the marker changed. No nudge while progressing, and so that A-NUDGE-IGNORED judges by the same marker as the nudge */
    dispatchSeen: join(dir, 'cache', 'dispatch-seen.json'),
    /** The time a hand-over failed. Even if failures continue, it is attempted once every few minutes */
    dispatchFailure: join(dir, 'cache', 'dispatch-failure.json'),
    /** The last time PRs were lined up in issue bodies. Even if failures continue, it is attempted once per interval */
    linksState: join(dir, 'cache', 'links-state.json'),
    /** A lock held while lining up PRs in issue bodies */
    linksLock: join(dir, 'cache', 'links.lock'),
    /** The original body just before an issue's body is rewritten (one per line). Kept so that a person's edit can be restored */
    linksBefore: join(dir, 'log', 'links-before.jsonl'),
    /** The state of stall detection (Epics with nobody working, members with no issue to hand over, fingerprints of notifications shown) */
    alertsState: join(dir, 'cache', 'alerts-state.json'),
    /** A lock held while reading, correcting, and writing the detection state. So that watch processes do not notify twice */
    alertsLock: join(dir, 'cache', 'alerts.lock'),
    /** The lock of each member's watch process */
    memberWatchLock: (name: string) => join(dir, 'cache', `dispatch-watch-${name}.lock`),
  }
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Writes to a temporary file and then replaces, so that a reader does not see a half-written file. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`)
  renameSync(tmp, path)
}

export function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${line}\n`)
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A lock that holds a pid. If the owner is alive, it cannot be taken. If the owner is dead, it is taken over. */
export function tryLock(path: string): boolean {
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    const owner = Number(readFileSync(path, 'utf8'))
    if (owner === process.pid) return true
    if (Number.isInteger(owner) && owner > 0 && isPidAlive(owner)) return false
    writeFileSync(path, String(process.pid))
    return true
  }
}

export function releaseLock(path: string): void {
  try {
    if (Number(readFileSync(path, 'utf8')) === process.pid) rmSync(path)
  } catch {
    // If there is no lock, does nothing
  }
}

/**
 * When an external command (gh) fails, the Error's message contains the whole long query text and the cause is cut off.
 * For a failure that has stderr, keeps the exit code and the stderr.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const { status, stderr } = error as Error & { readonly status?: unknown; readonly stderr?: unknown }
  const text = typeof stderr === 'string' ? stderr : stderr instanceof Buffer ? stderr.toString('utf8') : ''
  if (text.trim() === '') return error.message
  return `gh exited with ${typeof status === 'number' ? status : '?'}: ${text.trim().replace(/\s+/g, ' ')}`
}

export function logError(p: Paths, where: string, error: unknown): void {
  appendLine(p.errors, `${new Date().toISOString()} ${where}: ${describeError(error).slice(0, 1000)}`)
}
