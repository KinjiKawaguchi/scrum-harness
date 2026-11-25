import { closeSync, openSync, readSync } from 'node:fs'
import type { Tokens, TranscriptScan, UsageRow } from '../../ports/index.ts'

/**
 * Reads the lines of a Claude Code transcript (~/.claude/projects/<dir>/<session>.jsonl). The format is an internal record and is not
 * public, so a line that cannot be read is dropped. One response (requestId) appears on several lines, one per content block, and
 * every one of them carries the same usage. A response is counted once, taking the largest value of each field.
 */
const ASSISTANT = '"type":"assistant"'
const TITLE_KEYS = ['"customTitle"', '"agentName"']

type ParsedLine = { readonly row?: UsageRow; readonly title?: string }

/** A token count is a whole, non-negative number; anything else counts as 0. */
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)

function tokensOf(usage: Record<string, unknown>): Tokens {
  const creation = (usage.cache_creation ?? {}) as Record<string, unknown>
  const total = num(usage.cache_creation_input_tokens)
  const oneHour = num(creation.ephemeral_1h_input_tokens)
  const fiveMinutes = creation.ephemeral_5m_input_tokens === undefined ? total - oneHour : num(creation.ephemeral_5m_input_tokens)
  return { input: num(usage.input_tokens), cacheWrite5m: Math.max(0, fiveMinutes), cacheWrite1h: oneHour, cacheRead: num(usage.cache_read_input_tokens), output: num(usage.output_tokens) }
}

function parseAssistant(record: Record<string, unknown>): ParsedLine {
  const message = (record.message ?? {}) as Record<string, unknown>
  const at = Date.parse(String(record.timestamp))
  const model = typeof message.model === 'string' ? message.model : ''
  const requestId = typeof record.requestId === 'string' ? record.requestId : typeof message.id === 'string' ? message.id : ''
  const usage = message.usage as Record<string, unknown> | undefined
  const isBilled = usage !== undefined && model !== '' && model !== '<synthetic>' && requestId !== '' && !Number.isNaN(at)
  return isBilled ? { row: { requestId, at, model, isFast: usage.speed === 'fast', tokens: tokensOf(usage) } } : {}
}

export function parseLine(line: string): ParsedLine {
  const isAssistant = line.includes(ASSISTANT)
  const hasTitle = !isAssistant && TITLE_KEYS.some((key) => line.includes(key))
  if (!isAssistant && !hasTitle) return {}
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    return {}
  }
  if (isAssistant && record.type === 'assistant') return parseAssistant(record)
  const title = record.customTitle ?? record.agentName
  return typeof title === 'string' && title !== '' ? { title } : {}
}

/** Merges two lines of the same response. Each field takes the larger value, so an earlier line with a partial usage does not win. */
export function mergeRow(prev: UsageRow | undefined, next: UsageRow): UsageRow {
  if (prev === undefined) return next
  const max = (key: keyof Tokens) => Math.max(prev.tokens[key], next.tokens[key])
  return { ...prev, tokens: { input: max('input'), cacheWrite5m: max('cacheWrite5m'), cacheWrite1h: max('cacheWrite1h'), cacheRead: max('cacheRead'), output: max('output') } }
}

const CHUNK = 8 * 1024 * 1024
const MARKERS = [ASSISTANT, ...TITLE_KEYS].map((one) => Buffer.from(one))

/** Where one file's scan collects what it finds. It is mutated only inside scanFile, to read a large file quickly. */
type Sink = { readonly rows: Map<string, UsageRow>; readonly titles: Set<string> }

function consume(line: Buffer, sink: Sink, skipRequestIds: ReadonlySet<string>): void {
  if (!MARKERS.some((marker) => line.includes(marker))) return
  const parsed = parseLine(line.toString('utf8'))
  if (parsed.row !== undefined && !skipRequestIds.has(parsed.row.requestId)) sink.rows.set(parsed.row.requestId, mergeRow(sink.rows.get(parsed.row.requestId), parsed.row))
  if (parsed.title !== undefined) sink.titles.add(parsed.title)
}

/**
 * Reads a file from `from` and counts up to the last newline. A last line that does not end in a newline is still being written, so
 * the next scan reads it. A large line (a tool result) is turned into a string only if it contains one of the marker strings.
 */
export function scanFile(path: string, from: number, skipRequestIds: ReadonlySet<string> = new Set()): TranscriptScan {
  const sink: Sink = { rows: new Map(), titles: new Set() }
  const fd = openSync(path, 'r')
  let position = from
  let carry: Buffer = Buffer.alloc(0)
  try {
    const buffer = Buffer.alloc(CHUNK)
    for (let read = readSync(fd, buffer, 0, CHUNK, position); read > 0; read = readSync(fd, buffer, 0, CHUNK, position)) {
      position += read
      const data = carry.length === 0 ? buffer.subarray(0, read) : Buffer.concat([carry, buffer.subarray(0, read)])
      let start = 0
      for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
        consume(data.subarray(start, end), sink, skipRequestIds)
        start = end + 1
      }
      carry = Buffer.from(data.subarray(start))
    }
  } finally {
    closeSync(fd)
  }
  return { rows: [...sink.rows.values()], titles: [...sink.titles], endOffset: position - carry.length }
}
