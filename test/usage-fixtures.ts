import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tokens, TranscriptFile, TranscriptSource } from '../src/ports/index.ts'
import { scanFile } from '../src/adapters/claude-code/transcript-lines.ts'

export const SESSION_A = '11111111-1111-4111-8111-111111111111'
export const SESSION_B = '22222222-2222-4222-8222-222222222222'
export const SESSION_OTHER = '33333333-3333-4333-8333-333333333333'

export const ZERO: Tokens = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }

type LineOptions = { readonly requestId?: string; readonly at?: string; readonly model?: string; readonly speed?: string; readonly usage?: Record<string, unknown> }

/** One assistant line of a transcript, in the shape Claude Code writes it. */
export function assistantLine(options: LineOptions = {}): string {
  const { requestId = 'req_1', at = '2026-11-24T10:00:00.000Z', model = 'claude-opus-5-5', speed, usage = { input_tokens: 10, output_tokens: 20 } } = options
  return JSON.stringify({ type: 'assistant', requestId, timestamp: at, message: { model, usage: { ...usage, ...(speed === undefined ? {} : { speed }) } } })
}

export const titleLine = (title: string): string => JSON.stringify({ type: 'custom-title', customTitle: title })

export function writeTranscript(path: string, lines: readonly string[], isComplete = true): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, lines.join('\n') + (isComplete ? '\n' : ''))
}

export const appendTranscript = (path: string, lines: readonly string[]): void => appendFileSync(path, lines.join('\n') + '\n')

/** A transcript source over files of a test: the listing is given, and scanning reads the real file. */
export function sourceOf(files: readonly TranscriptFile[], names: ReadonlyMap<string, string> = new Map()): TranscriptSource {
  return { files: () => files, names: () => names, scan: (file, from, skip) => scanFile(file.path, from, skip) }
}

export const fileOf = (path: string, sessionId: string, size: number, project = 'proj', isSubagent = false): TranscriptFile => ({ path, sessionId, project, isSubagent, size })

/** The text of a message body in the tests, so a test can check that it never leaves the transcript. */
export const BODY = 'SECRET-BODY-do-not-copy'

type SendOptions = { readonly id?: string; readonly at?: string; readonly input?: Record<string, unknown> }

/** One assistant line with a SendMessage call, in the shape Claude Code writes it (the body is in `message` and `content`). */
export function sendMessageLine(options: SendOptions = {}): string {
  const { id = 'toolu_1', at = '2026-11-24T10:00:00.000Z', input = { to: 'SWE1', summary: 'Asks for a review' } } = options
  return JSON.stringify({ type: 'assistant', timestamp: at, requestId: 'req_x', message: { content: [{ type: 'tool_use', id, name: 'SendMessage', input: { message: BODY, content: BODY, ...input } }] } })
}
