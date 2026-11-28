import { label } from '../board/rules.ts'
import { loadSnapshot } from '../board/snapshot.ts'
import type { Config } from '../config.ts'
import type { Ack } from '../findings/acks.ts'
import type { Ports } from '../ports/index.ts'
import { appendLine, readJson, writeJson } from '../store.ts'
import type { SessionSignal } from '../team/types.ts'
import { baseName } from '../usage/attribution.ts'
import { continuedNotice, readContinued, type ContinuedRecord } from './continued.ts'
import type { Continuation } from './config.ts'
import { memberReport } from './list.ts'
import { isOnStandby, readStandby } from './standby.ts'
import type { WatchdogDeps } from './lifecycle.ts'

/** How long after the line is typed the window is looked at, to see whether the line left the input box. */
const CHECK_AFTER_MS = 5000

/** The live session of a member, the latest when several answer to the name. */
function liveSignal(signals: readonly SessionSignal[], name: string): SessionSignal | undefined {
  return signals.filter((signal) => signal.isAlive && signal.state !== 'ended' && baseName(signal.name) === name).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

/** Whether an acknowledgement of the member's idleness (T-IDLE) is in force: someone said it waits on purpose. */
const isAcknowledged = (acks: readonly Ack[], name: string, now: Date): boolean => acks.some((ack) => ack.rule === 'T-IDLE' && ack.subject === name && Date.parse(ack.until) > now.getTime())

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether the line is still in the input box of the window: one of its last lines starts with the prompt mark and the beginning of the text. */
export function isStillTyped(screen: string | null, text: string): boolean {
  const lastLines = (screen ?? '').split('\n').slice(-8).join('\n')
  return new RegExp(`^[ \\t]*[\\u203A\\u276F>][ \\t]+${escapeRegExp(text.slice(0, 24))}`, 'm').test(lastLines)
}

/** The In Progress issues assigned to a member, by their references. */
function doingOf(deps: WatchdogDeps, config: Config, name: string): readonly string[] {
  const snapshot = deps.paths === undefined ? null : loadSnapshot(deps.paths)
  return (snapshot?.items ?? []).filter((item) => item.kind === 'issue' && item.status === config.statuses.doing && item.assignee !== null && baseName(item.assignee) === name).map((item) => label(item))
}

/** Types the continuation text into one member's window, looks that it was submitted, and keeps the record. Returns the notice. */
function typeContinuation(ports: Ports, deps: WatchdogDeps, session: string, name: string, continuation: Continuation, since: string, doing: readonly string[], idleMinutes: number): string {
  const now = deps.now()
  ports.members.say(session, name, continuation.text)
  deps.sleep(CHECK_AFTER_MS)
  const record: ContinuedRecord = { idleSince: since, at: now.toISOString(), minutes: idleMinutes, items: doing, isSubmitted: !isStillTyped(ports.members.screen(session, name), continuation.text) }
  if (deps.paths !== undefined) {
    writeJson(deps.paths.memberContinued, { ...readContinued(deps.paths.memberContinued), [name]: record })
    appendLine(deps.paths.events, JSON.stringify({ at: record.at, type: 'continued', name, ...(doing.length === 0 ? {} : { items: doing }), minutes: idleMinutes, isSubmitted: record.isSubmitted }))
  }
  return continuedNotice(name, record)
}

/**
 * Codex ends its turn and waits for a message that no one sends ("continuing...", and nothing follows). A member with `continuation` that has been idle at
 * its prompt for its `afterMinutes` is told to go on: the text is typed into its window, at most once for each stretch of idleness, whether or not it has
 * an issue In Progress, and not while an acknowledgement of its idleness (T-IDLE) or a standby the lead set is in force. Claude Code members are not given the setting.
 * Returns the lines to print: one for each member that was told, and (with `--dry-run`) for each that would be. The notice is also the finding M-CONTINUED
 * (`members/rules.ts`), which is how the TechLead hears of it.
 */
export function continueIdle(config: Config, ports: Ports, deps: WatchdogDeps, isDryRun = false): readonly string[] {
  const launch = config.launch
  if (launch === undefined || deps.paths === undefined) return []
  const configured = Object.entries(launch.members).flatMap(([name, spec]) => (spec.continuation === undefined || spec.product !== 'codex' ? [] : [{ name, continuation: spec.continuation }]))
  if (configured.length === 0) return []
  const signals = deps.signals()
  const report = memberReport(config, ports.members.windows(launch.tmuxSession), signals)
  const continued = readContinued(deps.paths.memberContinued)
  const acks = readJson<readonly Ack[]>(deps.paths.acks, [])
  const now = deps.now()
  const standby = readStandby(deps.paths.memberStandby)
  const snapshot = loadSnapshot(deps.paths)
  return configured.flatMap(({ name, continuation }): readonly string[] => {
    const row = report.rows.find((one) => one.name === name)
    const signal = liveSignal(signals, name)
    if (row === undefined || !row.hasWindow || signal === undefined || signal.state !== 'idle') return []
    const idleMinutes = Math.floor((now.getTime() - Date.parse(signal.since)) / 60_000)
    if (idleMinutes < continuation.afterMinutes || continued[name]?.idleSince === signal.since || isAcknowledged(acks, name, now) || isOnStandby(standby, snapshot, config, name, now)) return []
    const doing = doingOf(deps, config, name)
    if (isDryRun) return [`${name}: would be told to go on (idle ${idleMinutes} minutes; ${doing.length === 0 ? 'no In Progress item' : `${doing.join(', ')} In Progress`})`]
    try {
      return [typeContinuation(ports, deps, launch.tmuxSession, name, continuation, signal.since, doing, idleMinutes)]
    } catch (error) {
      return [`${name}: could not be told to go on: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`]
    }
  })
}
