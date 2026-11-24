import { homedir } from 'node:os'
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
import { shellPatterns } from './board/commands.ts'
import { alertsOf } from './alerts/config.ts'
import { dispatchOf } from './config.ts'
import { checkIdleAck, type IdleAckCheck } from './dispatch/idle-ack.ts'
import { checkOverrunAck } from './sprint/overrun-ack.ts'
import type { IssueComment } from './sprint/overrun-mark.ts'

export type Flags = Readonly<Record<string, string | true>>

/** 値を取らない旗。次の語を値として取らず、位置引数のままにする (scrum dispatch --once <名前> の名前が、旗の値にならないように)。 */
const SWITCH_FLAGS: ReadonlySet<string> = new Set(['once', 'json', 'refresh', 'dry-run'])

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

export function lintCommand(p: Paths, config: Config, flags: Flags): string {
  const now = new Date()
  const snapshot = flags.refresh === true ? refreshSnapshot(p, config, now) : undefined
  const { active, acked } = lintAll(loadContext(p, config, now, snapshot ?? undefined))
  if (flags.json === true) return JSON.stringify({ active, acked }, null, 2)
  const fetchedAt = readJson<{ fetchedAt?: string }>(p.snapshot, {}).fetchedAt ?? '未取得'
  const lines = active.length === 0 ? ['指摘なし'] : active.map(formatFinding)
  return [`ボードの控え: ${fetchedAt}`, ...lines, `受け入れ済み ${acked.length} 件 (scrum acks)`].join('\n')
}

export function teamCommand(p: Paths, config: Config): string {
  const now = new Date()
  const { members } = loadContext(p, config, now)
  return members
    .map((member) => {
      const minutes = member.since === null ? '' : ` ${Math.floor((now.getTime() - Date.parse(member.since)) / 60_000)} 分`
      return `${member.name}\t${member.state}${minutes}`
    })
    .join('\n')
}

/** T-IDLE の受け入れの検査。設定が無ければ、理由を検査できないので記録しない。 */
function checkIdle(config: Config | null, reason: string, durationMs: number, now: Date): IdleAckCheck {
  if (config === null) return { ok: false, message: '設定が無いので、T-IDLE の受け入れは記録できない' }
  return checkIdleAck({ reason, durationMs, now, config })
}

export function ackCommand(
  p: Paths,
  positional: readonly string[],
  flags: Flags,
  config: Config | null = null,
  now: Date = new Date(),
  readComments?: (repo: string, number: number) => readonly IssueComment[],
): string {
  const [rule, subject] = positional
  const reason = typeof flags.reason === 'string' ? flags.reason : null
  const duration = typeof flags.for === 'string' ? parseDuration(flags.for) : null
  const until = typeof flags.until === 'string' ? new Date(flags.until) : duration === null ? null : new Date(now.getTime() + duration)
  if (!rule || !subject || reason === null || until === null || Number.isNaN(until.getTime())) {
    return '使い方: scrum ack <規則> <対象> (--for 2h | --until 2026-10-09T22:00+09:00) --reason "<理由>"'
  }
  const idle = rule === 'T-IDLE' ? checkIdle(config, reason, until.getTime() - now.getTime(), now) : null
  if (idle !== null && !idle.ok) return idle.message
  const slotAt = idle?.ok === true ? idle.slotAt : null
  const overrun = rule === OVERRUN_RULE ? checkOverrunAck(p, subject, config, now, readComments) : null
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
  return `受け入れた: ${rule} ${subject} (${ack.until} まで) ${reason}`
}

export function acksCommand(p: Paths): string {
  const now = Date.now()
  const live = readJson<readonly Ack[]>(p.acks, []).filter((ack) => Date.parse(ack.until) > now)
  const basisText = (a: Ack): string => (a.basis !== undefined ? ` (根拠: ${a.basis})` : a.rule === OVERRUN_RULE ? ' (超過の扱いを決めた記録が無いので、指摘は消えない)' : '')
  return live.length === 0 ? '受け入れ済みの例外なし' : live.map((a) => `${a.rule} ${a.subject} ${a.until} まで: ${a.reason}${basisText(a)}`).join('\n')
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

/** statusline から呼ぶ。TechLead のセッションでだけ、控えから短い表示を返す。ボードは取りに行かない。 */
export function statuslineCommand(p: Paths, config: Config, input: Record<string, unknown>): string {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const now = new Date()
  const identity = sessionId === '' ? null : resolveIdentity(p, sessionId, now, config)
  if (identity === null || roleOf(identity.name, config) !== 'techlead') return ''
  return formatStatusline(lintAll(loadContext(p, config, now)).active)
}

function settingsPath(): string {
  return process.env.SCRUM_SETTINGS ?? join(homedir(), '.claude', 'settings.json')
}

export function installCommand(p: Paths, isInstall: boolean): string {
  const bin = fileURLToPath(new URL('../bin/scrum', import.meta.url))
  const backup = updateSettings(settingsPath(), (settings) => (isInstall ? withHooks(settings, bin) : withoutHooks(settings)))
  const created = isInstall && ensureConfig(p)
  return [
    `${isInstall ? '足した' : '外した'}: ${settingsPath()} のフック (控え: ${backup})`,
    created ? `設定を作った: ${p.dir}/config.json` : '',
  ].filter((line) => line !== '').join('\n')
}

/** 設定のスクリプト名から、bin/scrum が読む型を書く。中身が変わったときだけ書く。 */
export function writeShellPatterns(p: Paths, config: Config): void {
  const { post, pre } = shellPatterns(config)
  // 3 行目: 部下の待機 (空いたら次の仕事を渡す) を起こすか。bin/scrum が、部下の watch で node を起こすかを決めるのに読む
  // 4 行目: 窓口の待機 (止まりの検知を進め、窓口に送る文を受け取る) を起こすか。窓口の名前が決まっているときだけ 1
  const alerts = alertsOf(config)
  const liaisonFlag = alerts.enabled && alerts.liaison !== undefined ? '1' : '0'
  const content = `${post}\n${pre}\n${dispatchOf(config).enabled ? '1' : '0'}\n${liaisonFlag}\n`
  if (readText(p.shellPatterns) === content) return
  mkdirSync(dirname(p.shellPatterns), { recursive: true })
  writeFileSync(p.shellPatterns, content)
}

export function checkpointCommand(p: Paths, config: Config): string {
  const now = new Date()
  const record = runCheckpoint(p, config, now)
  if (record === null) return '記録する節目は無い (最後の節目は記録済みか、sprint の設定が無い)'
  const over = record.items.filter((item) => item.over !== null && item.over > 0).length
  const clock = config.sprint === undefined ? record.scheduledFor : localClock(Date.parse(record.scheduledFor), config.sprint)
  return [`節目 ${clock} を記録した。作業中 ${record.items.length} 件、超過 ${over} 件`, pointsCommand(p, config)].join('\n')
}

export function pointsCommand(p: Paths, config: Config): string {
  const snapshot = loadSnapshot(p) ?? { fetchedAt: new Date(0).toISOString(), items: [], openIssues: [] }
  const now = new Date()
  return formatPoints(snapshot, loadCountingHistory(p, now), config, now, loadCompletions(p))
}
