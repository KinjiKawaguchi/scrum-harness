import { label } from '../board/rules.ts'
import type { Snapshot } from '../board/types.ts'
import type { Config } from '../config.ts'
import { usageOffsetMinutes } from '../agency-runtime/config.ts'
import { makeFinding, type Finding } from '../findings/types.ts'
import { SCRUM_CLI } from '../cli-path.ts'
import { readJson, writeJson } from '../store.ts'
import type { MemberState } from '../team/types.ts'
import { baseName } from '../usage/attribution.ts'

/** A member the lead keeps running and idle on purpose: an idle session costs nothing, and stopping and resuming it costs a re-read of its conversation. */
export type Standby = {
  readonly name: string
  readonly reason: string
  readonly since: string
  /** When it ends by itself; absent when it lasts until the member gets an item or it is turned off */
  readonly until?: string
  readonly by: string
}

export const readStandby = (path: string): readonly Standby[] => readJson<readonly Standby[]>(path, [])

/** The open issues of the team that are the member's: In Progress or Next with the member as assignee. */
function itemsOf(snapshot: Snapshot | null, config: Config, name: string): readonly string[] {
  return (snapshot?.items ?? [])
    .filter((item) => item.kind === 'issue' && item.state === 'OPEN' && item.assignee === name && (item.status === config.statuses.doing || item.status === config.statuses.next))
    .map(label)
}

export type StandbyView = { readonly active: readonly Standby[]; readonly ended: readonly { readonly standby: Standby; readonly why: 'item' | 'until' }[] }

/** Which marks are in force now, and which have ended and why: the member got an item, or `until` has passed. Pure. */
export function viewStandby(records: readonly Standby[], snapshot: Snapshot | null, config: Config, now: Date): StandbyView {
  const ended: { readonly standby: Standby; readonly why: 'item' | 'until' }[] = []
  const active = records.filter((one) => {
    if (one.until !== undefined && Date.parse(one.until) <= now.getTime()) return (ended.push({ standby: one, why: 'until' }), false)
    if (itemsOf(snapshot, config, one.name).length > 0) return (ended.push({ standby: one, why: 'item' }), false)
    return true
  })
  return { active, ended }
}

/** Whether a member is on standby now (a mark in force). */
export const isOnStandby = (records: readonly Standby[], snapshot: Snapshot | null, config: Config, name: string, now: Date): boolean =>
  viewStandby(records, snapshot, config, now).active.some((one) => one.name === name)

/** Drops the marks that have ended, so that a member that took an item and is idle again is not on standby without the lead saying so. */
export function pruneStandby(path: string, snapshot: Snapshot | null, config: Config, now: Date): void {
  const records = readStandby(path)
  const { active } = viewStandby(records, snapshot, config, now)
  if (active.length !== records.length) writeJson(path, active)
}

/** The deadline of `--until`: a time (`2026-12-01T09:00:00Z`), a clock time in the team's zone (`17:30`, the next one), or a length (`90m`, `4h`). */
export function parseUntil(text: string, now: Date, config: Config): Date | null {
  const length = /^(\d{1,4})([mh])$/.exec(text)
  if (length !== null) return new Date(now.getTime() + Number(length[1]) * (length[2] === 'h' ? 3_600_000 : 60_000))
  const clock = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (clock !== null) {
    const shift = usageOffsetMinutes(config) * 60_000
    const local = new Date(now.getTime() + shift)
    const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(clock[1]), Number(clock[2])) - shift
    return new Date(today > now.getTime() ? today : today + 86_400_000)
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return null
  const at = Date.parse(text)
  return Number.isNaN(at) ? null : new Date(at)
}

export type StandbyRequest = { readonly name: string; readonly off: boolean; readonly reason: string | undefined; readonly until: string | undefined; readonly caller: string }

/** Whether the caller is the lead: the session of the lead, or a person at a terminal (no session name). A member's session is not. */
export const isLeadCaller = (caller: string, config: Config): boolean => caller === '' || baseName(caller) === config.techlead

/** `scrum member standby <name> [--until <time>] --reason <text>` and `--off`. Returns the text to print. */
export function standbyCommand(path: string, config: Config, request: StandbyRequest, now: Date): string {
  const { name } = request
  if (!isLeadCaller(request.caller, config)) return `only the lead (${config.techlead}) puts a member on standby; this session is ${request.caller}`
  if (!config.members.includes(name)) return `${name} is not a member of this team (${config.members.join(', ')})`
  const records = readStandby(path)
  if (request.off) {
    if (!records.some((one) => one.name === name)) return `${name} is not on standby`
    writeJson(path, records.filter((one) => one.name !== name))
    return `${name}: standby ended`
  }
  const reason = request.reason?.trim() ?? ''
  if (reason === '') return '--reason is needed: say why the member is kept idle (it is shown in `scrum member list`)'
  const until = request.until === undefined ? null : parseUntil(request.until, now, config)
  if (request.until !== undefined && (until === null || until.getTime() <= now.getTime())) return '--until must be a time in the future: 17:30, 4h, 90m, or 2026-12-01T09:00:00Z'
  const mark: Standby = { name, reason, since: now.toISOString(), by: request.caller === '' ? 'terminal' : request.caller, ...(until === null ? {} : { until: until.toISOString() }) }
  writeJson(path, [...records.filter((one) => one.name !== name), mark])
  return `${name}: on standby${until === null ? '' : ` until ${until.toISOString()}`} (${reason}); it ends when the member gets an item, or with ${SCRUM_CLI} member standby ${name} --off`
}

/** What \`scrum member list\` adds to a member's line. */
export function standbyNote(standby: Standby | undefined): string {
  return standby === undefined ? '' : ` [standby since ${standby.since.slice(0, 16)}Z${standby.until === undefined ? '' : ` until ${standby.until.slice(0, 16)}Z`}: ${standby.reason}]`
}

const minutesSince = (iso: string, now: Date): number => Math.floor((now.getTime() - Date.parse(iso)) / 60_000)

/**
 * T-STANDBY-BUSY: a member on standby has been busy for a long time and has no item. The lead said it idles on purpose, so it should not be working; the mark
 * is stale (the member took on work without an issue). The lead ends it or puts the work on the board.
 */
export function lintStandbyBusy(active: readonly Standby[], members: readonly MemberState[], config: Config, now: Date): readonly Finding[] {
  return active.flatMap((standby) => {
    const member = members.find((one) => one.name === standby.name)
    if (member === undefined || member.state !== 'busy' || member.since === null) return []
    const minutes = minutesSince(member.since, now)
    if (minutes < config.untrackedMinutes) return []
    return [
      makeFinding({
        rule: 'T-STANDBY-BUSY',
        subject: standby.name,
        keySuffix: member.since,
        severity: 'medium',
        minutes,
        message: `${standby.name} is on standby (${standby.reason}) but has been busy for ${minutes} minutes with no item on the board, so the mark is stale`,
        fix: `Put what ${standby.name} is doing on the board and assign it, or end the standby with ${SCRUM_CLI} member standby ${standby.name} --off`,
      }),
    ]
  })
}
