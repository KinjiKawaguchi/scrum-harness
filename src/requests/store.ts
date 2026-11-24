import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson, type Paths } from '../store.ts'
import { isRequestId } from './model.ts'
import type { OwnerRequest } from './types.ts'

export function requestsDir(p: Paths): string {
  return join(p.dir, 'requests')
}

const isTime = (value: unknown): boolean => typeof value === 'string' && !Number.isNaN(Date.parse(value))
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Whether a stored value has the shape the harness relies on. A file edited by hand into another shape is skipped, not trusted. */
const isRequest = (value: unknown): value is OwnerRequest => {
  if (!isObject(value)) return false
  const { id, title, kind, waiting, createdAt, messages, options, blocks } = value
  return (
    typeof id === 'string' &&
    typeof title === 'string' &&
    (kind === 'question' || kind === 'proposal') &&
    (waiting === 'owner' || waiting === 'team') &&
    isTime(createdAt) &&
    Array.isArray(messages) &&
    messages.every((one) => isObject(one) && typeof one.from === 'string' && typeof one.text === 'string' && isTime(one.at)) &&
    Array.isArray(options) &&
    options.every((one) => isObject(one) && typeof one.key === 'string' && typeof one.text === 'string') &&
    Array.isArray(blocks) &&
    blocks.every((one) => typeof one === 'string')
  )
}

/** Reads every request, newest first. Files that cannot be read, or whose name is not a request id, are skipped. */
export function readRequests(p: Paths): readonly OwnerRequest[] {
  const dir = requestsDir(p)
  let names: readonly string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json') && isRequestId(name.slice(0, -5)))
  } catch {
    return []
  }
  return names
    .flatMap((name) => {
      const value = readJson<unknown>(join(dir, name), null)
      return isRequest(value) ? [value] : []
    })
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function readRequest(p: Paths, id: string): OwnerRequest | null {
  if (!isRequestId(id)) return null
  const value = readJson<unknown>(join(requestsDir(p), `${id}.json`), null)
  return isRequest(value) ? value : null
}

export function writeRequest(p: Paths, request: OwnerRequest): void {
  if (!isRequestId(request.id)) throw new Error(`not a request id: ${request.id}`)
  writeJson(join(requestsDir(p), `${request.id}.json`), request)
}
