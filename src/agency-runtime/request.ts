import { MAX_USAGE_DAYS, RUNTIME_VERSION, type RuntimeDecision, type RuntimeError, type RuntimeInput } from './types.ts'

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
/** GitHub rejects comment bodies above 65536 characters; stay well below so the added header fits. */
const MAX_TEXT_LENGTH = 60_000

type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)
const malformed = (message: string): RuntimeError => ({ status: 400, message })

function parseDecision(raw: unknown): RuntimeDecision | RuntimeError {
  if (!isObj(raw)) return malformed('decision must be an object')
  const { kind, target, by, payload } = raw
  if (kind !== 'answer' && kind !== 'judge') return malformed('decision.kind must be "answer" or "judge"')
  if (typeof target !== 'string' || target === '') return malformed('decision.target must be a non-empty string')
  if (typeof by !== 'string' || !ID.test(by)) return malformed('decision.by must be an id')
  if (!isObj(payload) || typeof payload.text !== 'string') return malformed('decision.payload.text must be a string')
  const choice = payload.choice
  if (choice !== undefined && typeof choice !== 'string') return malformed('decision.payload.choice must be a string')
  if (payload.text.length > MAX_TEXT_LENGTH || (choice?.length ?? 0) > MAX_TEXT_LENGTH) return malformed('decision text is too long')
  return { kind, target, by, payload: { text: payload.text, ...(choice === undefined ? {} : { choice }) } }
}

/** Reads the one JSON request the node writes to stdin. Anything that does not fit is a 400. */
export function parseRuntimeRequest(input: string): RuntimeInput | RuntimeError {
  let raw: unknown
  try {
    raw = JSON.parse(input)
  } catch {
    return malformed('stdin is not valid JSON')
  }
  if (!isObj(raw)) return malformed('the request must be a JSON object')
  if (raw.runtime !== RUNTIME_VERSION) return malformed(`runtime must be "${RUNTIME_VERSION}"`)
  if (typeof raw.org !== 'string' || !ID.test(raw.org)) return malformed('org must be an id')
  if (typeof raw.team !== 'string' || !ID.test(raw.team)) return malformed('team must be an id')
  const base = { runtime: RUNTIME_VERSION, org: raw.org, team: raw.team }
  if (raw.op === 'describe' || raw.op === 'view') return { ...base, op: raw.op }
  if (raw.op === 'tokenUsage') {
    const days = raw.days
    const isDays = typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= MAX_USAGE_DAYS
    return isDays ? { ...base, op: 'tokenUsage', days } : malformed(`days must be a whole number from 1 to ${MAX_USAGE_DAYS}`)
  }
  if (raw.op !== 'decide') return malformed('op must be "describe", "view", "decide", or "tokenUsage"')
  const decision = parseDecision(raw.decision)
  return 'status' in decision ? decision : { ...base, op: 'decide', decision }
}

export const isRuntimeError = (value: unknown): value is RuntimeError => isObj(value) && typeof value.status === 'number' && typeof value.message === 'string'
