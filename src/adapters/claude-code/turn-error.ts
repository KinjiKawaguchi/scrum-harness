import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TurnError } from '../../ports/index.ts'

const SESSION_ID = /^[0-9A-Za-z-]{8,64}$/

/** How much of the end of a transcript is read: the last turn is at its end, and a transcript can be many megabytes. */
const TAIL_BYTES = 128 * 1024

function transcriptPath(projectsDirs: readonly string[], sessionId: string): string | null {
  for (const root of projectsDirs) {
    try {
      const project = readdirSync(root).find((name) => statSyncSafe(join(root, name, `${sessionId}.jsonl`)))
      if (project !== undefined) return join(root, project, `${sessionId}.jsonl`)
    } catch {
      // A folder that cannot be read has no transcript of this session.
    }
  }
  return null
}

function statSyncSafe(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function tailLines(path: string): readonly string[] {
  const fd = openSync(path, 'r')
  try {
    const { size } = statSync(path)
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    // When only the end was read, the first line is a fragment.
    return size > length ? lines.slice(1) : lines
  } finally {
    closeSync(fd)
  }
}

type Record_ = { readonly type?: unknown; readonly isSidechain?: unknown; readonly isApiErrorMessage?: unknown; readonly error?: unknown; readonly timestamp?: unknown; readonly version?: unknown; readonly message?: { readonly content?: unknown } }

function parse(line: string): Record_ | null {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null ? (value as Record_) : null
  } catch {
    return null
  }
}

function firstText(record: Record_): string {
  const content = record.message?.content
  const part = Array.isArray(content) ? (content as readonly { readonly type?: unknown; readonly text?: unknown }[]).find((one) => typeof one.text === 'string') : undefined
  const text = typeof part?.text === 'string' ? part.text : typeof content === 'string' ? content : ''
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 300)
}

/** The user and assistant records at the end of a session's transcript, oldest first; none when it cannot be found or read. The format is not public. */
function recentRecords(projectsDirs: readonly string[], sessionId: string): readonly Record_[] {
  if (!SESSION_ID.test(sessionId)) return []
  try {
    const path = transcriptPath(projectsDirs, sessionId)
    if (path === null) return []
    return tailLines(path)
      .map(parse)
      .filter((record): record is Record_ => record !== null && (record.type === 'assistant' || record.type === 'user') && record.isSidechain !== true)
  } catch {
    return []
  }
}

const isError = (record: Record_): boolean => record.type === 'assistant' && record.isApiErrorMessage === true

/**
 * The API errors that ended the session's last turns. Claude Code writes one into the transcript as an assistant record with `isApiErrorMessage`.
 * `count` is how many of the latest assistant records in a row are errors (the person's messages between them do not break the run, a reply does), and
 * `isLast` whether the error is the very last record, so nothing came after it. Null when the last assistant record is not an error.
 */
export function claudeCodeTurnError(projectsDirs: readonly string[], sessionId: string): TurnError | null {
  const records = recentRecords(projectsDirs, sessionId)
  const assistants = records.filter((record) => record.type === 'assistant')
  const last = assistants.at(-1)
  if (last === undefined || !isError(last)) return null
  const count = assistants.toReversed().findIndex((record) => !isError(record))
  return {
    error: typeof last.error === 'string' && last.error !== '' ? last.error : 'unknown',
    text: firstText(last),
    at: typeof last.timestamp === 'string' ? last.timestamp : '',
    count: count === -1 ? assistants.length : count,
    isLast: records.at(-1) === last,
  }
}

/** The Claude Code version that wrote the session's latest records, or null. */
export function claudeCodeVersion(projectsDirs: readonly string[], sessionId: string): string | null {
  const version = recentRecords(projectsDirs, sessionId).findLast((record) => typeof record.version === 'string')?.version
  return typeof version === 'string' && /^[0-9A-Za-z.+-]{1,30}$/.test(version) ? version : null
}
