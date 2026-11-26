import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSnapshot, refreshSnapshot } from './board/snapshot.ts'
import { runCheckpoint } from './sprint/checkpoint-run.ts'
import { localClock } from './sprint/checkpoints.ts'
import { loadCompletions } from './sprint/completion.ts'
import { formatPoints } from './sprint/report.ts'
import { loadCountingHistory } from './sprint/counting-history.ts'
import type { Config } from './config.ts'
import { addAck, OVERRUN_RULE, parseDuration, type Ack } from './findings/acks.ts'
import { formatFinding, formatStatusline } from './findings/format.ts'
import { lintAll, loadContext } from './findings/lint.ts'
import { ensureConfig, updateSettings, withHooks, withoutHooks } from './install.ts'
import { formatReport, type MetricsEvent } from './metrics/events.ts'
import { appendLine, readJson, readText, writeJson, type Paths } from './store.ts'
import { resolveIdentity, roleOf } from './team/identity.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { alertsOf } from './alerts/config.ts'
import { dispatchOf } from './config.ts'
import { checkIdleAck, type IdleAckCheck } from './dispatch/idle-ack.ts'
import { checkOverrunAck } from './sprint/overrun-ack.ts'
import type { ActionReader, IssueThread, Ports, SessionDirectory } from './ports/index.ts'

export type Flags = Readonly<Record<string, string | true>>

/** Flags that take no value. The next word is not taken as the value but stays a positional argument (so that the name in scrum dispatch --once <name> does not become the flag's value). */
const SWITCH_FLAGS: ReadonlySet<string> = new Set(['once', 'json', 'refresh', 'dry-run', 'unassigned', 'adopts-unassigned'])

export function parseFlags(args: readonly string[]): { readonly positional: readonly string[]; readonly flags: Flags } {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const next = args[i + 1]
    if (SWITCH_FLAGS.has(arg.slice(2))) flags[arg.slice(2)] = true
    else if (next !== undefined && !next.startsWith('--')) {
      flags[arg.slice(2)] = next
      i++
    } else flags[arg.slice(2)] = true
  }
  return { positional, flags }
}

export function lintCommand(p: Paths, config: Config, flags: Flags, ports: Pick<Ports, 'board' | 'sessions'>): string {
  const now = new Date()
  const snapshot = flags.refresh === true ? refreshSnapshot(p, config, now, ports.board) : undefined
  const { active, acked } = lintAll(loadContext(p, config, now, ports.sessions, snapshot ?? undefined))
  if (flags.json === true) return JSON.stringify({ active, acked }, null, 2)
  const fetchedAt = readJson<{ fetchedAt?: string }>(p.snapshot, {}).fetchedAt ?? 'not fetched'
  const lines = active.length === 0 ? ['No findings'] : active.map(formatFinding)
  return [`Board copy: ${fetchedAt}`, ...lines, `${acked.length} acknowledged (scrum acks)`].join('\n')
}

export function teamCommand(p: Paths, config: Config, sessions: SessionDirectory): string {
  const now = new Date()
  const { members } = loadContext(p, config, now, sessions)
  return members
    .map((member) => {
      const minutes = member.since === null ? '' : ` ${Math.floor((now.getTime() - Date.parse(member.since)) / 60_000)} min`
      return `${member.name}\t${member.state}${minutes}`
    })
    .join('\n')
}

/** The check of a T-IDLE acknowledgement. If there is no config, the reason cannot be checked, so nothing is recorded. */
function checkIdle(config: Config | null, reason: string, durationMs: number, now: Date): IdleAckCheck {
  if (config === null) return { ok: false, message: 'There is no configuration, so a T-IDLE acknowledgement cannot be recorded' }
  return checkIdleAck({ reason, durationMs, now, config })
}

export function ackCommand(
  p: Paths,
  positional: readonly string[],
  flags: Flags,
  config: Config | null = null,
  now: Date = new Date(),
  issues: Pick<IssueThread, 'comments'> | null = null,
): string {
  const [rule, subject] = positional
  const reason = typeof flags.reason === 'string' ? flags.reason : null
  const duration = typeof flags.for === 'string' ? parseDuration(flags.for) : null
  const until = typeof flags.until === 'string' ? new Date(flags.until) : duration === null ? null : new Date(now.getTime() + duration)
  if (!rule || !subject || reason === null || until === null || Number.isNaN(until.getTime())) {
    return 'Usage: scrum ack <rule> <subject> (--for 2h | --until 2026-10-09T22:00+09:00) --reason "<reason>"'
  }
  const idle = rule === 'T-IDLE' ? checkIdle(config, reason, until.getTime() - now.getTime(), now) : null
  if (idle !== null && !idle.ok) return idle.message
  const slotAt = idle?.ok === true ? idle.slotAt : null
  const overrun = rule === OVERRUN_RULE ? checkOverrunAck(p, subject, config, now, issues) : null
  if (overrun !== null && !overrun.ok) return overrun.message
  const basis = overrun?.ok === true ? overrun.basis : null
  const ack: Ack = {
    rule,
    subject,
    until: until.toISOString(),
    reason,
    at: now.toISOString(),
    ...(slotAt === null ? {} : { slotAt }),
    ...(basis === null ? {} : { basis }),
  }
  writeJson(p.acks, addAck(readJson<readonly Ack[]>(p.acks, []), ack, now))
  appendLine(p.events, JSON.stringify({ at: ack.at, type: 'acked', rule, subject, until: ack.until, reason }))
  return `Acknowledged: ${rule} ${subject} (until ${ack.until}) ${reason}`
}

export function acksCommand(p: Paths): string {
  const now = Date.now()
  const live = readJson<readonly Ack[]>(p.acks, []).filter((ack) => Date.parse(ack.until) > now)
  const basisText = (a: Ack): string => (a.basis !== undefined ? ` (basis: ${a.basis})` : a.rule === OVERRUN_RULE ? ' (no record of how the overrun was handled, so the finding stays)' : '')
  return live.length === 0 ? 'No acknowledged exceptions' : live.map((a) => `${a.rule} ${a.subject} until ${a.until}: ${a.reason}${basisText(a)}`).join('\n')
}

export function reportCommand(p: Paths, flags: Flags): string {
  const since = typeof flags.since === 'string' ? new Date(`${flags.since}T00:00:00+09:00`) : new Date(Date.now() - 86_400_000)
  const events = readText(p.events)
    .split('\n')
    .filter((line) => line !== '')
    .flatMap((line): readonly MetricsEvent[] => {
      try {
        return [JSON.parse(line) as MetricsEvent]
      } catch {
        return []
      }
    })
  return formatReport(events, since)
}

/** Called from the statusline. Only in the TechLead's session, returns a short display from the board copy. It does not go to fetch the board. */
export function statuslineCommand(p: Paths, config: Config, input: Record<string, unknown>, sessions: SessionDirectory): string {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const now = new Date()
  const identity = sessionId === '' ? null : resolveIdentity(p, sessionId, now, config, sessions)
  if (identity === null || roleOf(identity.name, config) !== 'techlead') return ''
  return formatStatusline(lintAll(loadContext(p, config, now, sessions)).active)
}

export function installCommand(p: Paths, isInstall: boolean, targets: readonly string[], tools: readonly string[] = []): string {
  const bin = fileURLToPath(new URL('../bin/scrum', import.meta.url))
  const lines = targets.map((path) => {
    const backup = updateSettings(path, (settings) => (isInstall ? withHooks(settings, bin, tools) : withoutHooks(settings)))
    return `${isInstall ? 'Added' : 'Removed'}: the hooks in ${path} (${backup === null ? 'a new file' : `backup: ${backup}`})`
  })
  const created = isInstall && ensureConfig(p)
  return [...lines, created ? `Created the configuration: ${p.dir}/config.json` : ''].filter((line) => line !== '').join('\n')
}

/** From the configured script names, writes the patterns that bin/scrum reads. Writes only when the content changes. */
export function writeShellPatterns(p: Paths, config: Config, actions: ActionReader): void {
  const { post, pre } = actions.shellPatterns()
  // Line 3: whether to start the member's watch (hand over the next work once free). bin/scrum reads it to decide whether to start node in a member's watch
  // Line 4: whether to start the liaison's watch (advance stall detection and receive the text to send to the liaison). 1 only when the liaison's name is set
  const alerts = alertsOf(config)
  const liaisonFlag = alerts.enabled && alerts.liaison !== undefined ? '1' : '0'
  const content = `${post}\n${pre}\n${dispatchOf(config).enabled ? '1' : '0'}\n${liaisonFlag}\n`
  if (readText(p.shellPatterns) === content) return
  mkdirSync(dirname(p.shellPatterns), { recursive: true })
  writeFileSync(p.shellPatterns, content)
}

export function checkpointCommand(p: Paths, config: Config, ports: Pick<Ports, 'board' | 'writer'>): string {
  const now = new Date()
  const record = runCheckpoint(p, config, now, ports)
  if (record === null) return 'No checkpoint to record (the last one is already recorded, or there is no sprint configuration)'
  const over = record.items.filter((item) => item.over !== null && item.over > 0).length
  const clock = config.sprint === undefined ? record.scheduledFor : localClock(Date.parse(record.scheduledFor), config.sprint)
  return [`Recorded checkpoint ${clock}. ${record.items.length} In Progress, ${over} overrun`, pointsCommand(p, config)].join('\n')
}

export function pointsCommand(p: Paths, config: Config): string {
  const snapshot = loadSnapshot(p) ?? { fetchedAt: new Date(0).toISOString(), items: [], openIssues: [] }
  const now = new Date()
  return formatPoints(snapshot, loadCountingHistory(p, now), config, now, loadCompletions(p))
}
