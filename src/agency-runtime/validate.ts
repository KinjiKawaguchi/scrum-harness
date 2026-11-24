import type { TeamView } from './types.ts'

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const BLOCKED = ['needsDecision', 'external', 'waitingOnPrevious', 'timeOrEquipment']
const WORK_STATUS = ['backlog', 'next', 'inProgress', 'release', 'done']

type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Collects the first problem of a value against the TeamView rules. Unknown keys are ignored, as the specification says. */
class Check {
  problem: string | null = null
  fail(path: string, expected: string): void {
    this.problem ??= `${path}: expected ${expected}`
  }
  str(o: Obj, key: string, path: string): void {
    if (typeof o[key] !== 'string') this.fail(`${path}.${key}`, 'a string')
  }
  optStr(o: Obj, key: string, path: string): void {
    if (key in o && typeof o[key] !== 'string') this.fail(`${path}.${key}`, 'a string, or the key omitted')
  }
  bool(o: Obj, key: string, path: string): void {
    if (typeof o[key] !== 'boolean') this.fail(`${path}.${key}`, 'a boolean')
  }
  count(o: Obj, key: string, path: string): void {
    if (typeof o[key] !== 'number' || !Number.isInteger(o[key]) || o[key] < 0) this.fail(`${path}.${key}`, 'a non-negative integer')
  }
  matching(o: Obj, key: string, path: string, pattern: RegExp, what: string): void {
    if (typeof o[key] !== 'string' || !pattern.test(o[key])) this.fail(`${path}.${key}`, what)
  }
  oneOf(o: Obj, key: string, path: string, allowed: readonly string[]): void {
    if (typeof o[key] !== 'string' || !allowed.includes(o[key])) this.fail(`${path}.${key}`, `one of ${allowed.join(' | ')}`)
  }
  strings(o: Obj, key: string, path: string): void {
    if (!Array.isArray(o[key]) || !o[key].every((one) => typeof one === 'string')) this.fail(`${path}.${key}`, 'an array of strings')
  }
  list(o: Obj, key: string, path: string, each: (item: Obj, at: string) => void): void {
    const value = o[key]
    if (!Array.isArray(value)) return this.fail(`${path}.${key}`, 'an array')
    value.forEach((item, index) => (isObj(item) ? each(item, `${path}.${key}[${index}]`) : this.fail(`${path}.${key}[${index}]`, 'an object')))
  }
}

const timestamp = (c: Check, o: Obj, key: string, path: string) => c.matching(o, key, path, TIMESTAMP, 'an RFC 3339 UTC timestamp ending in Z')

function person(c: Check, o: Obj, at: string): void {
  c.str(o, 'id', at)
  c.str(o, 'label', at)
  c.oneOf(o, 'kind', at, ['agent', 'human'])
  c.oneOf(o, 'role', at, ['lead', 'member'])
  c.oneOf(o, 'state', at, ['working', 'idle', 'away', 'unknown'])
  if ('since' in o) timestamp(c, o, 'since', at)
  if ('waitingOn' in o) {
    const waiting = o.waitingOn
    if (!isObj(waiting) || (waiting.kind !== 'lead' && waiting.kind !== 'person')) c.fail(`${at}.waitingOn`, 'a {kind: person | lead} object')
    else if (waiting.kind === 'person') c.str(waiting, 'person', `${at}.waitingOn`)
  }
  c.str(o, 'status', at)
  c.strings(o, 'holding', at)
}

function request(c: Check, o: Obj, at: string): void {
  c.str(o, 'id', at)
  c.oneOf(o, 'kind', at, ['question', 'proposal', 'pendingDecision'])
  c.str(o, 'title', at)
  c.str(o, 'context', at)
  c.optStr(o, 'document', at)
  c.str(o, 'from', at)
  c.optStr(o, 'to', at)
  timestamp(c, o, 'createdAt', at)
  c.optStr(o, 'issue', at)
  c.strings(o, 'blocks', at)
  c.list(o, 'options', at, (option, here) => {
    c.str(option, 'key', here)
    c.str(option, 'text', here)
    c.bool(option, 'isRecommended', here)
    c.optStr(option, 'detail', here)
  })
  if ('thread' in o) {
    c.list(o, 'thread', at, (message, here) => {
      c.str(message, 'from', here)
      c.str(message, 'text', here)
      c.optStr(message, 'choice', here)
      timestamp(c, message, 'at', here)
    })
  }
  const answer = o.answerWith
  if (!isObj(answer)) return c.fail(`${at}.answerWith`, 'an object')
  c.oneOf(answer, 'kind', `${at}.answerWith`, ['answer', 'judge'])
  c.str(answer, 'target', `${at}.answerWith`)
}

function workItem(c: Check, o: Obj, at: string): void {
  c.str(o, 'ref', at)
  c.str(o, 'title', at)
  c.oneOf(o, 'status', at, WORK_STATUS)
  c.optStr(o, 'assignee', at)
  c.optStr(o, 'epic', at)
  if ('points' in o) c.count(o, 'points', at)
  if ('blocked' in o) {
    const blocked = o.blocked
    if (!isObj(blocked)) return c.fail(`${at}.blocked`, 'an object')
    c.oneOf(blocked, 'reason', `${at}.blocked`, BLOCKED)
    c.matching(blocked, 'since', `${at}.blocked`, DATE, 'a YYYY-MM-DD date')
  }
  if ('eta' in o) {
    const eta = o.eta
    if (!isObj(eta)) return c.fail(`${at}.eta`, 'an object')
    timestamp(c, eta, 'p50', `${at}.eta`)
    timestamp(c, eta, 'p80', `${at}.eta`)
    c.str(eta, 'basis', `${at}.eta`)
    c.bool(eta, 'isOverBudget', `${at}.eta`)
  }
}

function epic(c: Check, o: Obj, at: string): void {
  c.str(o, 'ref', at)
  c.str(o, 'title', at)
  for (const key of ['total', 'done', 'doing', 'remainingPoints']) c.count(o, key, at)
  c.list(o, 'blocked', at, (one, here) => {
    c.oneOf(one, 'reason', here, BLOCKED)
    c.count(one, 'count', here)
  })
  if ('forecast' in o) {
    const forecast = o.forecast
    if (!isObj(forecast)) return c.fail(`${at}.forecast`, 'an object')
    c.count(forecast, 'days', `${at}.forecast`)
    timestamp(c, forecast, 'at', `${at}.forecast`)
  }
  c.str(o, 'basis', at)
}

/** Returns null when the value is a valid TeamView, or a description of the first problem. */
export function teamViewProblem(value: unknown): string | null {
  const c = new Check()
  if (!isObj(value)) return 'teamView: expected an object'
  c.matching(value, 'org', 'teamView', ID, 'an id')
  c.matching(value, 'team', 'teamView', ID, 'an id')
  c.str(value, 'label', 'teamView')
  timestamp(c, value, 'generatedAt', 'teamView')
  c.list(value, 'people', 'teamView', (one, at) => person(c, one, at))
  c.list(value, 'requests', 'teamView', (one, at) => request(c, one, at))
  c.list(value, 'work', 'teamView', (one, at) => workItem(c, one, at))
  c.list(value, 'epics', 'teamView', (one, at) => epic(c, one, at))
  return c.problem
}

export function isTeamView(value: unknown): value is TeamView {
  return teamViewProblem(value) === null
}
