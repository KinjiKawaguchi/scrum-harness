import { closeSync, openSync, readSync } from 'node:fs'
import type { Tokens, TranscriptScan, UsageRow } from '../../ports/index.ts'

/**
 * Reads the lines of a Codex session record (`sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl`). The format is Codex's own and is not documented, so a
 * line that cannot be read is dropped. A response is a `token_count` event: its `last_token_usage` is what that response used, and `total_token_usage`
 * is the running total of the session, which is unique per response and so makes the response's id.
 * `input_tokens` includes the cached ones (`cached_input_tokens`), and `output_tokens` includes the reasoning ones, so total = input + output.
 */
const TOKEN_COUNT = '"token_count"'
const TURN_CONTEXT = '"turn_context"'
const SESSION_META = '"session_meta"'

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)

function tokensOf(usage: Record<string, unknown>): Tokens {
  const input = num(usage.input_tokens)
  const cached = Math.min(num(usage.cached_input_tokens), input)
  return { input: input - cached, cacheWrite5m: num(usage.cache_write_input_tokens), cacheWrite1h: 0, cacheRead: cached, output: num(usage.output_tokens) }
}

type Line = { readonly model?: string; readonly cwd?: string; readonly row?: Omit<UsageRow, 'model'> }

/** What one line says: the model of a turn, the directory of the session, or a response's usage. Nothing else of the line is read. */
export function parseRolloutLine(line: string, sessionId: string): Line {
  if (!line.includes(TOKEN_COUNT) && !line.includes(TURN_CONTEXT) && !line.includes(SESSION_META)) return {}
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    return {}
  }
  const payload = (record.payload ?? {}) as Record<string, unknown>
  if (record.type === 'turn_context') return typeof payload.model === 'string' && payload.model !== '' ? { model: payload.model } : {}
  if (record.type === 'session_meta') return typeof payload.cwd === 'string' && payload.cwd !== '' ? { cwd: payload.cwd } : {}
  if (record.type !== 'event_msg' || payload.type !== 'token_count') return {}
  const info = (payload.info ?? {}) as Record<string, unknown>
  const last = info.last_token_usage as Record<string, unknown> | undefined
  const total = num((info.total_token_usage as Record<string, unknown> | undefined)?.total_tokens)
  const at = Date.parse(String(record.timestamp))
  if (last === undefined || total === 0 || Number.isNaN(at)) return {}
  return { row: { requestId: `${sessionId}:${total}`, at, isFast: false, tokens: tokensOf(last) } }
}

const CHUNK = 8 * 1024 * 1024

/** The model and the directory a file starts with, from its first lines: a scan that starts in the middle needs the model of the turn it is in. */
export function headOf(path: string, sessionId: string): { readonly model: string | undefined; readonly cwd: string | undefined } {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const lines = buffer.subarray(0, read).toString('utf8').split('\n').slice(0, -1)
    const parsed = lines.map((line) => parseRolloutLine(line, sessionId))
    return { model: parsed.find((one) => one.model !== undefined)?.model, cwd: parsed.find((one) => one.cwd !== undefined)?.cwd }
  } finally {
    closeSync(fd)
  }
}

/**
 * Reads a file from `from` and counts up to the last newline (a last line without one is still being written, and the next scan reads it). A response
 * is counted once, by its running total. The model of a response is the model of the turn it is in, or the file's first model for a scan that starts
 * after the turn began.
 */
export function scanRollout(path: string, sessionId: string, from: number, skipRequestIds: ReadonlySet<string> = new Set()): TranscriptScan {
  const rows = new Map<string, UsageRow>()
  let model = from === 0 ? undefined : headOf(path, sessionId).model
  const fd = openSync(path, 'r')
  let position = from
  let carry: Buffer = Buffer.alloc(0)
  const consume = (line: Buffer): void => {
    const parsed = parseRolloutLine(line.toString('utf8'), sessionId)
    if (parsed.model !== undefined) model = parsed.model
    if (parsed.row !== undefined && !skipRequestIds.has(parsed.row.requestId)) rows.set(parsed.row.requestId, { ...parsed.row, model: model ?? '' })
  }
  try {
    const buffer = Buffer.alloc(CHUNK)
    for (let read = readSync(fd, buffer, 0, CHUNK, position); read > 0; read = readSync(fd, buffer, 0, CHUNK, position)) {
      position += read
      const data = carry.length === 0 ? buffer.subarray(0, read) : Buffer.concat([carry, buffer.subarray(0, read)])
      let start = 0
      for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
        consume(data.subarray(start, end))
        start = end + 1
      }
      carry = Buffer.from(data.subarray(start))
    }
  } finally {
    closeSync(fd)
  }
  return { rows: [...rows.values()].filter((row) => row.model !== ''), messages: [], titles: [], endOffset: position - carry.length }
}
