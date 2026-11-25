import { readFileSync, statSync } from 'node:fs'
import type { Flags } from '../cli-commands.ts'
import type { Paths } from '../store.ts'
import { authorOf, close, isOpen, isReservedName, newRequestId, parseNewRequest, reply, LIMITS } from './model.ts'
import { readRequest, readRequests, writeRequest } from './store.ts'
import type { OwnerRequest } from './types.ts'

export const REQUEST_USAGE = `scrum request: requests from the team to the owner
  scrum request add --from <name> [--document <Markdown file>]   Add one. The JSON on stdin: {"title","context","kind":"question|proposal","issue":"app#12","to":"<addressee's name; the owner if absent>","options":[{"key":"a","text":"...","isRecommended":true,"detail":"..."}],"blocks":["<people or issues that wait>"]}. A proposal needs two or more options; its body is the --document file.
  scrum request list [--all]          Open requests (--all adds closed ones)
  scrum request show <id>             One request with its thread
  scrum request reply <id> --from <name> --text "<text>"   Reply for the team (the turn returns to the owner)
  scrum request close <id> [--note "<what was done>"]      Close it once the team has acted on the answer (R-ANSWERED goes away)`

function line(request: OwnerRequest): string {
  const turn = !isOpen(request) ? 'closed' : request.waiting === 'owner' ? 'waiting for the owner' : "the team's turn"
  const issue = request.issue === undefined ? '' : ` ${request.issue}`
  const to = request.to === undefined ? '' : ` -> ${request.to}`
  return `${request.id} [${turn}] (${request.kind}) ${request.title}${issue} - ${request.from}${to}`
}

function show(request: OwnerRequest): string {
  const options = request.options.map((one) => `  ${one.key}: ${one.text}${one.isRecommended === true ? ' (recommended)' : ''}`)
  const messages = request.messages.map((one) => `  [${one.at}] ${authorOf(one)}${one.by === undefined ? '' : ` (decided by ${one.by})`}${one.choice === undefined ? '' : ` (chose: ${one.choice})`}: ${one.text}`)
  const parts = [line(request), request.context, ...(options.length > 0 ? ['Options:', ...options] : []), ...(messages.length > 0 ? ['Thread:', ...messages] : []), request.closeNote === undefined ? '' : `Closing note: ${request.closeNote}`]
  return parts.filter((part) => part !== '').join('\n')
}

const RESERVED_MESSAGE = '--from names the team session that acts; owner, board, and unverified are not session names, and the owner speaks only through a decision'

/** The session name from --from, or null when it is missing or too long, or 'reserved' when it is a name that stands for a person or the board. */
function nameFlag(flags: Flags): string | 'reserved' | null {
  const from = flags.from
  if (typeof from !== 'string' || from.trim() === '' || from.length > LIMITS.name) return null
  return isReservedName(from) ? 'reserved' : from.trim()
}

/** Reads the proposal's body from a file. A file that is too large or cannot be read is refused. */
function readDocument(path: string): string | { readonly error: string } {
  try {
    if (statSync(path).size > LIMITS.document * 4) return { error: `the --document file is too large (at most ${LIMITS.document} characters)` }
    return readFileSync(path, 'utf8')
  } catch {
    return { error: `cannot read the --document file: ${path}` }
  }
}

/** An id that no stored request has. A collision needs the same second and the same four characters, so a few tries are plenty. */
function freshId(p: Paths, now: Date): string {
  const ids = Array.from({ length: 5 }, () => newRequestId(now))
  return ids.find((id) => readRequest(p, id) === null) ?? ids[0] ?? newRequestId(now)
}

function addRequest(p: Paths, flags: Flags, stdin: string, now: Date): string {
  const from = nameFlag(flags)
  if (from === null) return 'pass --from <name>, the name of the session that files it'
  if (from === 'reserved') return RESERVED_MESSAGE
  let raw: unknown
  try {
    raw = JSON.parse(stdin)
  } catch {
    return 'pass JSON on stdin (run `scrum request` for the shape)'
  }
  const document = typeof flags.document === 'string' ? readDocument(flags.document) : null
  if (typeof document === 'object' && document !== null) return document.error
  const input = typeof document === 'string' && typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, unknown>), document } : raw
  const parsed = parseNewRequest(input, from, now, freshId(p, now))
  if (!parsed.ok) return `could not add: ${parsed.message}`
  writeRequest(p, parsed.value)
  return `added: ${parsed.value.id}`
}

function updateRequest(p: Paths, id: string | undefined, run: (request: OwnerRequest) => OwnerRequest | string): string {
  const request = id === undefined ? null : readRequest(p, id)
  if (request === null) return `no such request: ${id ?? '(no id)'}`
  const result = run(request)
  if (typeof result === 'string') return result
  writeRequest(p, result)
  return line(result)
}

export function requestCommand(p: Paths, positional: readonly string[], flags: Flags, stdin: string, now: Date): string {
  const [sub, id] = positional
  switch (sub) {
    case 'add':
      return addRequest(p, flags, stdin, now)
    case 'list': {
      const shown = readRequests(p).filter((one) => flags.all === true || isOpen(one))
      return shown.length === 0 ? 'no open requests' : shown.map(line).join('\n')
    }
    case 'show': {
      const request = id === undefined ? null : readRequest(p, id)
      return request === null ? `no such request: ${id ?? '(no id)'}` : show(request)
    }
    case 'reply':
      return updateRequest(p, id, (request) => {
        const from = nameFlag(flags)
        const text = typeof flags.text === 'string' ? flags.text.trim() : ''
        if (from === 'reserved') return RESERVED_MESSAGE
        if (from === null || text === '' || text.length > LIMITS.text) return `pass --from <name> and --text "<text of up to ${LIMITS.text} characters>"`
        return reply(request, from, text, now)
      })
    case 'close':
      return updateRequest(p, id, (request) => {
        if (!isOpen(request)) return `already closed: ${line(request)}`
        const note = typeof flags.note === 'string' ? flags.note.trim().slice(0, LIMITS.text) : ''
        return close(request, note, now)
      })
    default:
      return REQUEST_USAGE
  }
}
