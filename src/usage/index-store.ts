import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Tokens, TranscriptFile, TranscriptSource, UsageRow } from '../ports/index.ts'
import { readJson } from '../store.ts'

/**
 * What reading the transcripts left behind. Each file remembers how far it was read, so the next run reads only what was added.
 * Rows are summed per (session, minute, model, speed) to keep the file small. To count again from scratch, delete the file.
 */
export type FileMark = { readonly offset: number; readonly size: number; readonly lastRequestId: string | null }

/** [session index, minute (epoch / 60000), model index, 1 if fast mode, input, cache write 5m, cache write 1h, cache read, output] */
export type CompactRow = readonly [number, number, number, number, number, number, number, number, number]

export type UsageIndex = {
  readonly version: 1
  readonly updatedAt: string
  readonly files: Readonly<Record<string, FileMark>>
  readonly sessionIds: readonly string[]
  readonly models: readonly string[]
  /** The name a session recorded about itself. Used when no record maps the session id to a name. */
  readonly titles: Readonly<Record<string, string>>
  readonly rows: readonly CompactRow[]
}

export const EMPTY_INDEX: UsageIndex = { version: 1, updatedAt: new Date(0).toISOString(), files: {}, sessionIds: [], models: [], titles: {}, rows: [] }

export function readIndex(path: string): UsageIndex | null {
  const value = readJson<UsageIndex | null>(path, null)
  return value !== null && value.version === 1 && Array.isArray(value.rows) ? value : null
}

function indexOf(list: readonly string[], value: string): { readonly list: readonly string[]; readonly index: number } {
  const found = list.indexOf(value)
  return found === -1 ? { list: [...list, value], index: list.length } : { list, index: found }
}

const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
  cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
})

function compactRows(rows: readonly UsageRow[], session: number, models: readonly string[]): { readonly rows: readonly CompactRow[]; readonly models: readonly string[] } {
  const buckets = new Map<string, { model: number; minute: number; fast: number; tokens: Tokens }>()
  let modelList = models
  for (const row of rows) {
    const found = indexOf(modelList, row.model)
    modelList = found.list
    const minute = Math.floor(row.at / 60_000)
    const key = `${minute}:${found.index}:${row.isFast ? 1 : 0}`
    const prev = buckets.get(key)
    buckets.set(key, { model: found.index, minute, fast: row.isFast ? 1 : 0, tokens: prev === undefined ? row.tokens : addTokens(prev.tokens, row.tokens) })
  }
  const compact = [...buckets.values()].map((b): CompactRow => [session, b.minute, b.model, b.fast, b.tokens.input, b.tokens.cacheWrite5m, b.tokens.cacheWrite1h, b.tokens.cacheRead, b.tokens.output])
  return { rows: compact, models: modelList }
}

/**
 * Reads what one file has gained and adds it to the index. A read starts where the previous one ended (after the last newline),
 * never at the size seen when the files were listed: the file can grow while it is read.
 * A file shorter than where it was read to was rewritten. Its earlier rows stay, and only what follows its present end is read,
 * because reading from the start again would count the same responses twice.
 */
export function scanInto(index: UsageIndex, file: TranscriptFile, source: TranscriptSource): UsageIndex {
  const mark = index.files[file.path]
  if (mark !== undefined && file.size <= mark.offset) {
    return file.size === mark.offset ? index : { ...index, files: { ...index.files, [file.path]: { ...mark, offset: file.size, size: file.size } } }
  }
  const scan = source.scan(file, mark?.offset ?? 0, new Set(mark?.lastRequestId ? [mark.lastRequestId] : []))
  const session = indexOf(index.sessionIds, file.sessionId)
  const compact = compactRows(scan.rows, session.index, index.models)
  const lastRequestId = scan.rows.at(-1)?.requestId ?? mark?.lastRequestId ?? null
  const title = scan.titles.at(-1)
  return {
    ...index,
    files: { ...index.files, [file.path]: { offset: scan.endOffset, size: file.size, lastRequestId } },
    sessionIds: session.list,
    models: compact.models,
    titles: title === undefined || file.isSubagent ? index.titles : { ...index.titles, [file.sessionId]: title },
    rows: [...index.rows, ...compact.rows],
  }
}

/** The file is large, so it is written without indentation. */
function writeCompact(path: string, value: UsageIndex): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, path)
}

export function updateIndex(path: string, files: readonly TranscriptFile[], source: TranscriptSource, now: Date): UsageIndex {
  const updated = files.reduce((index, file) => scanInto(index, file, source), readIndex(path) ?? EMPTY_INDEX)
  const result = { ...updated, updatedAt: now.toISOString() }
  writeCompact(path, result)
  return result
}
