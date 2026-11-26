import { MAX_ACTIVITY_LIMIT, MAX_USAGE_DAYS, MAX_UTC_OFFSET_MINUTES, MIN_UTC_OFFSET_MINUTES, RUNTIME_VERSION, type RuntimeDecision, type RuntimeError, type RuntimeInput } from './types.ts'

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
/** RFC 3339 in UTC, ending in Z, as the protocol's `Timestamp` */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
/** GitHub rejects comment bodies above 65536 characters; stay well below so the added header fits. */
const MAX_TEXT_LENGTH = 60_000
/** A choice is the key of an option, so it is short. */
const MAX_CHOICE_LENGTH = 200
/** A participant's runtime name. */
const MAX_NAME_LENGTH = 80

type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)
const malformed = (message: string): RuntimeError => ({ status: 400, message })

function parseDecision(raw: unknown): RuntimeDecision | RuntimeError {
  if (!isObj(raw)) return malformed('decision must be an object')
  const { kind, target, by, byParticipant, payload } = raw
  if (kind !== 'answer' && kind !== 'judge') return malformed('decision.kind must be "answer" or "judge"')
  if (typeof target !== 'string' || target === '') return malformed('decision.target must be a non-empty string')
  if (typeof by !== 'string' || !ID.test(by)) return malformed('decision.by must be an id')
  if (byParticipant !== undefined && !(typeof byParticipant === 'string' && byParticipant.trim() !== '' && byParticipant.length <= MAX_NAME_LENGTH)) return malformed('decision.byParticipant must be a name')
  if (!isObj(payload) || typeof payload.text !== 'string') return malformed('decision.payload.text must be a string')
  const choice = payload.choice
  if (choice !== undefined && typeof choice !== 'string') return malformed('decision.payload.choice must be a string')
  if (payload.text.length > MAX_TEXT_LENGTH || (choice?.length ?? 0) > MAX_CHOICE_LENGTH) return malformed('decision text or choice is too long')
  return { kind, target, by, ...(byParticipant === undefined ? {} : { byParticipant }), payload: { text: payload.text, ...(choice === undefined ? {} : { choice }) } }
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
  if (raw.op === 'activity') {
    const { since, limit } = raw
    if (typeof since !== 'string' || !TIMESTAMP.test(since) || Number.isNaN(Date.parse(since))) return malformed('since must be a time such as 2026-11-24T12:00:00Z')
    const isLimit = typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= MAX_ACTIVITY_LIMIT
    return isLimit ? { ...base, op: 'activity', since, limit } : malformed(`limit must be a whole number from 1 to ${MAX_ACTIVITY_LIMIT}`)
  }
  if (raw.op === 'participantMetrics') {
    const { days, utcOffsetMinutes } = raw
    if (!(typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= MAX_USAGE_DAYS)) return malformed(`days must be a whole number from 1 to ${MAX_USAGE_DAYS}`)
    if (utcOffsetMinutes === undefined) return { ...base, op: 'participantMetrics', days }
    const isOffset = typeof utcOffsetMinutes === 'number' && Number.isInteger(utcOffsetMinutes) && utcOffsetMinutes >= MIN_UTC_OFFSET_MINUTES && utcOffsetMinutes <= MAX_UTC_OFFSET_MINUTES
    return isOffset ? { ...base, op: 'participantMetrics', days, utcOffsetMinutes } : malformed(`utcOffsetMinutes must be a whole number from ${MIN_UTC_OFFSET_MINUTES} to ${MAX_UTC_OFFSET_MINUTES}`)
  }
  if (raw.op !== 'decide') return malformed('op must be "describe", "view", "decide", "tokenUsage", "activity", or "participantMetrics"')
  const decision = parseDecision(raw.decision)
  return 'status' in decision ? decision : { ...base, op: 'decide', decision }
}

export const isRuntimeError = (value: unknown): value is RuntimeError => isObj(value) && typeof value.status === 'number' && typeof value.message === 'string'
