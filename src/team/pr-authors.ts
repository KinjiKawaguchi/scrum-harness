import { renameSync, writeFileSync } from 'node:fs'
import { shortRepo } from '../config.ts'
import type { ToolCall } from '../ports/index.ts'
import { appendLine, readText } from '../store.ts'
import { baseName } from '../usage/attribution.ts'

/** How long the record is kept: as long as the state log, and the range `memberMetrics` answers. */
export const PR_AUTHORS_DAYS = 90

/** The member whose session opened a pull request, at the time its hook saw the tool result. `ref` is the pull request's reference on the board. */
export type PrAuthor = { readonly at: string; readonly name: string; readonly sessionId: string; readonly ref: string }

const PULL_URL = /https?:\/\/[^\s/"']+\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/
const GH_PR_CREATE = /(^|[\s;&|(])gh\s+(?:[^\s;&|]+\s+)*?pr\s+create(\s|$)/
const MCP_CREATE = /^mcp__.+__create_pull_request$/

function textOf(response: unknown): string {
  if (typeof response === 'string') return response
  try {
    return JSON.stringify(response) ?? ''
  } catch {
    return ''
  }
}

/**
 * The pull request a tool call opened: `gh pr create` in a Bash command, or the `create_pull_request` tool of an MCP server, with the pull request's
 * own URL in the result (which names its repository and number, so nothing is guessed from a title or a branch). Null for any other call, and for a
 * result without such a URL.
 */
export function openedPullRequest(call: ToolCall): string | null {
  const command = call.input.command
  const isCreate = call.tool === 'Bash' ? typeof command === 'string' && GH_PR_CREATE.test(command) : MCP_CREATE.test(call.tool)
  if (!isCreate || call.response === undefined) return null
  const match = PULL_URL.exec(textOf(call.response))
  return match === null ? null : `${shortRepo(`${match[1]}/${match[2]}`)}#${match[3]}`
}

export function recordPrAuthor(path: string, author: PrAuthor): void {
  appendLine(path, JSON.stringify({ ...author, name: baseName(author.name) }))
}

function isAuthor(value: unknown): value is PrAuthor {
  if (typeof value !== 'object' || value === null) return false
  const one = value as Partial<PrAuthor>
  return typeof one.name === 'string' && typeof one.ref === 'string' && typeof one.sessionId === 'string' && typeof one.at === 'string' && !Number.isNaN(Date.parse(one.at))
}

/** The records in the file, oldest first. A line that cannot be read is dropped. */
export function readPrAuthorRecords(path: string): readonly PrAuthor[] {
  const records = readText(path)
    .split('\n')
    .flatMap((line): readonly PrAuthor[] => {
      try {
        const value: unknown = JSON.parse(line)
        return isAuthor(value) ? [value] : []
      } catch {
        return []
      }
    })
  return records.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/** Pull request reference → the member that opened it. A pull request has one opener; if two records name it, the first wins. */
export function readPrAuthors(path: string): ReadonlyMap<string, string> {
  const authors = new Map<string, string>()
  for (const record of readPrAuthorRecords(path)) if (!authors.has(record.ref)) authors.set(record.ref, record.name)
  return authors
}

/** Rewrites the file without the records older than the retention, when there are any. Safe to skip. */
export function trimPrAuthors(path: string, now: Date): void {
  const records = readPrAuthorRecords(path)
  const cutoff = now.getTime() - PR_AUTHORS_DAYS * 86_400_000
  const kept = records.filter((record) => Date.parse(record.at) > cutoff)
  if (kept.length === records.length) return
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, kept.map((record) => `${JSON.stringify(record)}\n`).join(''))
  renameSync(tmp, path)
}
