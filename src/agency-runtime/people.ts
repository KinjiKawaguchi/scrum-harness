import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import type { Config } from '../config.ts'
import { OWNER } from '../requests/types.ts'
import type { MemberState } from '../team/types.ts'
import { isFinished, workStatusOf } from './work.ts'
import type { PersonStatus, Request } from './types.ts'

/** The name the runtime uses for the owner. A request addressed to nobody, and a permission prompt, go to this person. */
export const OWNER_ID = OWNER

const minutesSince = (iso: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000))
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** Refs of the open items assigned to a person that are not finished. */
function holdingOf(name: string, items: readonly BoardItem[], config: Config): string[] {
  return items
    .filter((item) => item.kind === 'issue' && item.state === 'OPEN' && item.assignee === name && !isFinished(workStatusOf(item, config)) && workStatusOf(item, config) !== null)
    .map(label)
}

function minutesText(member: MemberState, now: Date): string {
  return member.since === null ? 'a while' : plural(minutesSince(member.since, now), 'minute', 'minutes')
}

function activeStatus(holding: readonly string[], items: readonly BoardItem[], config: Config): string {
  const doing = items.filter((item) => holding.includes(label(item)) && item.status === config.statuses.doing).map(label)
  return doing.length > 0 ? `Working on ${doing.join(', ')}` : 'Working'
}

function stateOf(member: MemberState, role: 'lead' | 'member', holding: readonly string[], items: readonly BoardItem[], requests: readonly Request[], config: Config, now: Date): Omit<PersonStatus, 'id' | 'label' | 'kind' | 'role' | 'holding'> {
  const since = member.since === null ? {} : { since: new Date(member.since).toISOString() }
  if (member.state === 'waiting') {
    return { state: 'working', ...since, waitingOn: { kind: 'person', person: OWNER_ID }, status: 'Permission prompt: waiting for approval' }
  }
  if (member.state === 'busy') return { state: 'working', ...since, status: activeStatus(holding, items, config) }
  if (member.state === 'idle') {
    const idleFor = member.since === null ? 0 : minutesSince(member.since, now)
    const nextCount = items.filter((item) => item.kind === 'issue' && item.state === 'OPEN' && item.status === config.statuses.next).length
    const next = nextCount === 0 ? 'nothing in Next' : `${nextCount} in Next`
    const blocking = requests.find((request) => request.blocks.includes(member.name))
    if (blocking !== undefined) return { state: 'idle', ...since, waitingOn: { kind: 'person', person: OWNER_ID }, status: `Waiting on the owner: ${blocking.title}` }
    const isWaitingOnLead = role === 'member' && idleFor >= config.idleMinutes
    return { state: 'idle', ...since, ...(isWaitingOnLead ? { waitingOn: { kind: 'lead' as const } } : {}), status: `Idle for ${minutesText(member, now)}; ${next}` }
  }
  return { state: 'away', status: 'No live session' }
}

/** The lead and the members as agents, then the owner as a human. */
export function peopleOf(members: readonly MemberState[], items: readonly BoardItem[], requests: readonly Request[], config: Config, now: Date): PersonStatus[] {
  const agents = members.map((member): PersonStatus => {
    const role = member.name === config.techlead ? 'lead' : 'member'
    const holding = holdingOf(member.name, items, config)
    return { id: member.name, label: member.name, kind: 'agent', role, ...stateOf(member, role, holding, items, requests, config, now), holding }
  })
  const waiting = requests.length === 0 ? 'No requests are waiting for an answer' : `${plural(requests.length, 'request is', 'requests are')} waiting for an answer`
  const owner: PersonStatus = { id: OWNER_ID, label: config.ownerLabel, kind: 'human', role: 'member', state: 'unknown', status: waiting, holding: [] }
  return [...agents, owner]
}
