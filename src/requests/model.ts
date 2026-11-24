import { OWNER, type OwnerRequest, type RequestKind, type RequestOption } from './types.ts'

const KINDS: readonly RequestKind[] = ['question', 'proposal']
const LABEL = /^[A-Za-z0-9._-]+#\d+$/
const ID = /^r-\d{8}-\d{6}-[a-z0-9]{4}$/

export const LIMITS = { title: 200, context: 4000, text: 4000, options: 8, optionKey: 20, optionText: 300, optionDetail: 2000, document: 40_000, blocks: 20, name: 80 } as const

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

const fail = (message: string): Parsed<never> => ({ ok: false, message })

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max

export function isRequestId(id: string): boolean {
  return ID.test(id)
}

/** Built from the time and four random characters. Only this fixed shape is used, so an id is always safe as a file name. */
export function newRequestId(now: Date, random: () => number = Math.random): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-')
  const suffix = Array.from({ length: 4 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)]).join('')
  return `r-${stamp}-${suffix}`
}

function parseOptions(raw: unknown): Parsed<readonly RequestOption[]> {
  if (raw === undefined) return { ok: true, value: [] }
  if (!Array.isArray(raw) || raw.length > LIMITS.options) return fail(`options must be an array of at most ${LIMITS.options} items`)
  const options = raw.map((one): RequestOption | null => {
    const { key, text, isRecommended, detail } = (one ?? {}) as Record<string, unknown>
    if (!isText(key, LIMITS.optionKey) || !isText(text, LIMITS.optionText)) return null
    if (detail !== undefined && !(typeof detail === 'string' && detail.length <= LIMITS.optionDetail)) return null
    const hasDetail = typeof detail === 'string' && detail.trim() !== ''
    return { key: key.trim(), text: text.trim(), ...(isRecommended === true ? { isRecommended: true } : {}), ...(hasDetail ? { detail: detail.trim() } : {}) }
  })
  if (options.some((one) => one === null)) return fail(`each option needs a key (up to ${LIMITS.optionKey} characters) and a text (up to ${LIMITS.optionText})`)
  const keys = options.map((one) => one?.key)
  if (new Set(keys).size !== keys.length) return fail('option keys must be different')
  return { ok: true, value: options as readonly RequestOption[] }
}

function parseBlocks(raw: unknown): Parsed<readonly string[]> {
  if (raw === undefined) return { ok: true, value: [] }
  const isValid = Array.isArray(raw) && raw.length <= LIMITS.blocks && raw.every((one) => isText(one, LIMITS.name))
  return isValid ? { ok: true, value: (raw as readonly string[]).map((one) => one.trim()) } : fail(`blocks must be an array of at most ${LIMITS.blocks} names`)
}

/** Checks a new request from the team at the system boundary (the JSON on the command's stdin). */
export function parseNewRequest(raw: unknown, from: string, now: Date, id: string): Parsed<OwnerRequest> {
  if (typeof raw !== 'object' || raw === null) return fail('pass a JSON object')
  const record = raw as Record<string, unknown>
  if (!isText(record.title, LIMITS.title)) return fail(`title must be text of up to ${LIMITS.title} characters`)
  if (record.context !== undefined && !(typeof record.context === 'string' && record.context.length <= LIMITS.context)) return fail(`context must be at most ${LIMITS.context} characters`)
  const kind = record.kind ?? 'question'
  if (!KINDS.includes(kind as RequestKind)) return fail(`kind must be one of ${KINDS.join(' | ')}`)
  if (record.issue !== undefined && !(typeof record.issue === 'string' && LABEL.test(record.issue))) return fail('issue must look like "<repo>#<number>"')
  if (record.document !== undefined && !(typeof record.document === 'string' && record.document.length <= LIMITS.document)) return fail(`document must be Markdown of at most ${LIMITS.document} characters`)
  if (kind === 'proposal' && !(Array.isArray(record.options) && record.options.length >= 2)) return fail('a proposal needs at least two options (including declining it)')
  if (record.to !== undefined && !isText(record.to, LIMITS.name)) return fail('to must be the addressee\'s name')
  const options = parseOptions(record.options)
  if (!options.ok) return options
  const blocks = parseBlocks(record.blocks)
  if (!blocks.ok) return blocks
  return {
    ok: true,
    value: {
      id,
      title: (record.title as string).trim(),
      context: typeof record.context === 'string' ? record.context.trim() : '',
      kind: kind as RequestKind,
      from,
      createdAt: now.toISOString(),
      ...(typeof record.issue === 'string' ? { issue: record.issue } : {}),
      ...(typeof record.to === 'string' ? { to: record.to.trim() } : {}),
      ...(typeof record.document === 'string' && record.document.trim() !== '' ? { document: record.document } : {}),
      blocks: blocks.value,
      options: options.value,
      waiting: OWNER,
      messages: [],
    },
  }
}

export type AnswerInput = { readonly text: string; readonly choice?: string }

/** Checks an answer: one of the options, or text, or both. */
export function parseAnswer(raw: unknown, request: OwnerRequest): Parsed<AnswerInput> {
  if (typeof raw !== 'object' || raw === null) return fail('pass a JSON object')
  const { text, choice } = raw as Record<string, unknown>
  const body = typeof text === 'string' ? text.trim() : ''
  if (body.length > LIMITS.text) return fail(`text must be at most ${LIMITS.text} characters`)
  if (choice !== undefined && !(typeof choice === 'string' && request.options.some((one) => one.key === choice))) return fail('choice must be the key of one of the options')
  if (body === '' && choice === undefined) return fail('give a choice or text')
  return { ok: true, value: { text: body, ...(typeof choice === 'string' ? { choice } : {}) } }
}

/** The owner answered (`by` is the id of the person who answered). The turn moves to the team, and a closed request reopens so a late answer still reaches the team. */
export function answer(request: OwnerRequest, input: AnswerInput, now: Date, by?: string): OwnerRequest {
  const { closedAt: _closedAt, closeNote: _closeNote, ...open } = request
  const message = { from: OWNER, text: input.text, ...(input.choice === undefined ? {} : { choice: input.choice }), ...(by === undefined ? {} : { by }), at: now.toISOString() }
  return { ...open, waiting: 'team', messages: [...request.messages, message] }
}

/** The team replied (a follow-up question, or the result). The turn returns to the owner. */
export function reply(request: OwnerRequest, from: string, text: string, now: Date): OwnerRequest {
  return { ...request, waiting: OWNER, messages: [...request.messages, { from, text, at: now.toISOString() }] }
}

/** The team acted on the answer. A closed request counts neither as waiting for the owner nor as the team's turn. */
export function close(request: OwnerRequest, note: string, now: Date): OwnerRequest {
  return { ...request, closedAt: now.toISOString(), ...(note === '' ? {} : { closeNote: note }) }
}

export const isOpen = (request: OwnerRequest): boolean => request.closedAt === undefined

/** Whether this answer is the one the request already ends with, so applying it again changes nothing. */
export function isSameAnswer(request: OwnerRequest, input: AnswerInput, by?: string): boolean {
  const last = request.messages.at(-1)
  return request.waiting === 'team' && isOpen(request) && last?.from === OWNER && last.text === input.text && last.choice === input.choice && last.by === by
}

/** The owner's latest answer as one line: the chosen option and the text. */
export function describeAnswer(request: OwnerRequest): string {
  const last = request.messages.findLast((one) => one.from === OWNER)
  if (last === undefined) return ''
  const option = request.options.find((one) => one.key === last.choice)
  const chosen = option === undefined ? '' : `Chose "${option.key}: ${option.text}"`
  return [chosen, last.text].filter((part) => part !== '').join('. ')
}
