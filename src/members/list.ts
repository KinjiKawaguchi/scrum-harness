import { alertsOf } from '../alerts/config.ts'
import type { Config } from '../config.ts'
import type { SessionSignal } from '../team/types.ts'
import { aggregateMembers } from '../team/state.ts'
import type { MemberSource } from './funding.ts'

export type MemberRow = {
  readonly name: string
  readonly role: 'lead' | 'member' | 'liaison'
  /** Whether the host has a window of that name */
  readonly hasWindow: boolean
  /** The activity of the live session of that name; `unknown` when there is none */
  readonly state: 'busy' | 'idle' | 'waiting' | 'unknown'
  readonly isRunning: boolean
}

export type MemberReport = {
  readonly rows: readonly MemberRow[]
  /** Windows of the session that are not in the configuration (and not on the ignore list) */
  readonly unlisted: readonly string[]
  /** Whether the host's windows could be read; false when there is no launch section, or the session or the host is missing */
  readonly isHostKnown: boolean
}

/** The lead, the members, and the liaison that the configuration names, each once. */
function namedMembers(config: Config): readonly { readonly name: string; readonly role: MemberRow['role'] }[] {
  const liaison = alertsOf(config).liaison
  const named = [{ name: config.techlead, role: 'lead' as const }, ...config.members.map((name) => ({ name, role: 'member' as const })), ...(liaison === undefined ? [] : [{ name: liaison, role: 'liaison' as const }])]
  return named.filter((one, index) => named.findIndex((other) => other.name === one.name) === index)
}

/** What is configured against what runs: the host's windows and the live sessions. Pure. */
export function memberReport(config: Config, windows: readonly string[] | null, signals: readonly SessionSignal[]): MemberReport {
  const named = namedMembers(config)
  const states = new Map(aggregateMembers(signals, named.map((one) => one.name)).map((one) => [one.name, one.state]))
  const rows = named.map(({ name, role }): MemberRow => {
    const hasWindow = windows?.includes(name) ?? false
    const state = states.get(name) ?? 'unknown'
    return { name, role, hasWindow, state, isRunning: hasWindow || state !== 'unknown' }
  })
  const ignored = new Set(config.launch?.ignoreWindows ?? [])
  const unlisted = (windows ?? []).filter((window) => !named.some((one) => one.name === window) && !ignored.has(window))
  return { rows, unlisted, isHostKnown: windows !== null }
}

/** The account a member started on, or why it was refused: only for a member that runs, or whose last start was refused. */
function sourceNote(row: MemberRow, sources: readonly MemberSource[]): string {
  const source = sources.find((one) => one.name === row.name)
  if (source === undefined) return ''
  if (source.state === 'refused') return row.isRunning ? '' : ` [start refused: ${source.reason ?? 'no reason given'}]`
  return row.isRunning && source.source !== '' ? ` [source ${source.source}]` : ''
}

export function formatReport(report: MemberReport, sources: readonly MemberSource[] = []): string {
  const lines = report.rows.map((row) => `${row.name.padEnd(20)} ${row.role.padEnd(8)} ${row.isRunning ? `running (${row.state})` : 'not running'}${row.hasWindow ? '' : report.isHostKnown ? ' [no window]' : ''}${sourceNote(row, sources)}`)
  const drift = [
    ...report.unlisted.map((window) => `running but not in the configuration: ${window}`),
    ...report.rows.filter((row) => !row.isRunning).map((row) => `listed but not running: ${row.name}`),
  ]
  const note = report.isHostKnown ? [] : ['The host\'s windows could not be read (no launch section, no such session, or no tmux), so only the session records are used.']
  return [...lines, ...(drift.length === 0 ? ['no drift'] : ['', ...drift]), ...note].join('\n')
}
