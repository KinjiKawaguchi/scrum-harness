import { existsSync, readdirSync, statSync, unlinkSync, chmodSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { releaseLock, tryLock } from './store.ts'

/**
 * A long-lived process that answers `scrum runtime` calls, so that a call does not start node and load the harness's modules (about 0.2 CPU-s and, on a
 * machine that swaps, seconds). `bin/scrum runtime` connects to its socket with `nc -U`, and falls back to answering by itself when there is none.
 *
 * A request is the state directory on one line, then the JSON request exactly as the node wrote it. The answer is the same JSON line the command prints,
 * and the connection closes. One server answers for every state directory (every team of the node), one request at a time: what it does for a request
 * is synchronous and short (it never waits for `gh`: a board read and the transcripts' reading are started in processes of their own).
 */
export type RuntimeServerOptions = {
  readonly socketPath: string
  /** The answer to a request for a state directory: the line the runtime command prints. Called with `SCRUM_STATE_DIR` left to it. */
  readonly answer: (stateDir: string, input: string) => string
  /** A value that changes when the source the server runs from changes: the server ends then, and the next call starts one that has the new source. */
  readonly sourceStamp: () => string
  /** How long without a request before it ends (default 20 minutes) */
  readonly idleMs?: number
  /** How long it runs at most (default 6 hours), so that nothing it holds grows without end */
  readonly maxAgeMs?: number
  /** Called when the server is listening */
  readonly onListening?: () => void
}

const DEFAULT_IDLE_MS = 20 * 60_000
const DEFAULT_MAX_AGE_MS = 6 * 3_600_000
/** A client that sent nothing complete in this long is dropped. */
const CLIENT_MS = 10_000
/** How often the source is looked at (a request after that checks it again). */
const STAMP_EVERY_MS = 1000

const errorLine = (status: number, message: string): string => `${JSON.stringify({ error: { status, message } })}\n`

/** The lock that keeps one server for a socket: the process id of the server, in a file next to the socket. */
export const lockPathOf = (socketPath: string): string => `${socketPath}.lock`

/** Whether a server already answers on the socket. */
function isServed(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath)
    probe.once('connect', () => (probe.destroy(), resolve(true)))
    probe.once('error', () => resolve(false))
  })
}

/** The newest modification time among the source files of a directory tree, as a string. */
export function newestMtime(root: string): string {
  let newest = 0
  try {
    for (const name of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!name.endsWith('.ts')) continue
      newest = Math.max(newest, statSync(join(root, name)).mtimeMs)
    }
  } catch {
    // A file that goes away while it is looked at changes the answer on the next look.
  }
  return String(newest)
}

/** Splits a request into its state directory and the JSON, once the JSON is complete (or the client has said all it will). */
function parse(received: string, isEnded: boolean): { readonly stateDir: string; readonly input: string } | 'shutdown' | null {
  const newline = received.indexOf('\n')
  if (newline === -1) return isEnded ? { stateDir: received, input: '' } : null
  const stateDir = received.slice(0, newline)
  if (stateDir === '!shutdown') return 'shutdown'
  const input = received.slice(newline + 1)
  if (isEnded) return { stateDir, input }
  try {
    JSON.parse(input)
    return { stateDir, input }
  } catch {
    return null
  }
}

/** Runs until it has been idle, has run its time, the source changed, or it was asked to stop. Resolves with the reason. Resolves at once, with `already`, when a server answers. */
export async function serveRuntime(options: RuntimeServerOptions): Promise<'idle' | 'age' | 'source' | 'stopped' | 'already'> {
  const { socketPath, sourceStamp } = options
  // One server at most: the lock is what says so. A socket that refuses a connection is not proof that no server holds it (a busy server's queue is full,
  // and a machine under load fills it), so a socket is never taken from a server by looking at the socket alone.
  const lock = lockPathOf(socketPath)
  if (!tryLock(lock)) return 'already'
  if (existsSync(socketPath)) {
    // A server of a version that had no lock may still hold it.
    if (await isServed(socketPath)) {
      releaseLock(lock)
      return 'already'
    }
    try {
      unlinkSync(socketPath)
    } catch {
      // The listen below says what is wrong.
    }
  }
  const startStamp = sourceStamp()
  let lastStampAt = 0
  let isChanged = false
  const hasChanged = (): boolean => {
    if (!isChanged && Date.now() - lastStampAt >= STAMP_EVERY_MS) {
      lastStampAt = Date.now()
      isChanged = sourceStamp() !== startStamp
    }
    return isChanged
  }
  return new Promise((resolve, reject) => {
    let idleTimer: NodeJS.Timeout | undefined
    let isEnding = false
    const finish = (reason: 'idle' | 'age' | 'source' | 'stopped'): void => {
      if (isEnding) return
      isEnding = true
      clearTimeout(idleTimer)
      server.close()
      try {
        unlinkSync(socketPath)
      } catch {
        // Already gone.
      }
      releaseLock(lock)
      resolve(reason)
    }
    const arm = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => finish('idle'), options.idleMs ?? DEFAULT_IDLE_MS)
      idleTimer.unref()
    }
    const respond = (client: Socket, received: string, isEnded: boolean): boolean => {
      const request = parse(received, isEnded)
      if (request === null) return false
      if (request === 'shutdown') {
        client.end('ok\n', () => finish('stopped'))
        return true
      }
      if (hasChanged()) {
        // No answer: the caller answers by itself, and the next call starts a server with the new source.
        client.end(() => finish('source'))
        return true
      }
      let line: string
      if (!isAbsolute(request.stateDir) || !existsSync(join(request.stateDir, 'config.json'))) line = errorLine(503, 'scrum-harness is not configured')
      else {
        try {
          line = options.answer(request.stateDir, request.input)
        } catch (error) {
          line = errorLine(503, `the runtime cannot act now: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`)
        }
      }
      client.end(line)
      arm()
      return true
    }
    const server = createServer((client) => {
      let received = ''
      let isDone = false
      client.setEncoding('utf8')
      client.setTimeout(CLIENT_MS, () => client.destroy())
      client.on('error', () => client.destroy())
      client.on('data', (chunk: string) => {
        if (isDone) return
        received += chunk
        isDone = respond(client, received, false)
      })
      client.on('end', () => {
        if (!isDone) {
          isDone = true
          respond(client, received, true)
        }
      })
    })
    server.once('error', (error) => {
      releaseLock(lock)
      reject(error)
    })
    server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o600)
      } catch {
        // The directory's own permissions still apply.
      }
      arm()
      const age = setTimeout(() => finish('age'), options.maxAgeMs ?? DEFAULT_MAX_AGE_MS)
      age.unref()
      options.onListening?.()
    })
  })
}
