import { rmSync } from 'node:fs'
import { SCRUM_CLI } from '../cli-path.ts'
import { applyCommands, mergeContext, parseBoardCommands, referencedLabels, type BoardCommand } from '../board/commands.ts'
import { isRefreshDue, loadSnapshot, saveSnapshot } from '../board/snapshot.ts'
import { formatList, formatSummary } from '../findings/format.ts'
import { lintAll, loadContext, type LintResult } from '../findings/lint.ts'
import { decideStop, remember, unseen } from '../findings/notify.ts'
import type { Finding } from '../findings/types.ts'
import { appendLine, readJson, writeJson } from '../store.ts'
import type { HookDeps } from './handlers.ts'

const INJECT_LIMIT = 6

function lintNow(deps: HookDeps): LintResult {
  return lintAll(loadContext(deps.p, deps.config, deps.now))
}

function markNotified(deps: HookDeps, current: readonly Finding[], added: readonly Finding[]): void {
  writeJson(deps.p.notified, remember(readJson<readonly string[]>(deps.p.notified, []), current, added))
}

function refreshIfStale(deps: HookDeps): void {
  if (isRefreshDue(deps.p, deps.config, deps.now)) deps.spawnRefresh()
}

export function recordEvent(deps: HookDeps, type: string, detail: Record<string, unknown>): void {
  appendLine(deps.p.events, JSON.stringify({ at: deps.now.toISOString(), type, ...detail }))
}

/** セッションの始まり・再開・圧縮の後に、全体の要約を入れる。 */
export function techleadSessionStart(deps: HookDeps): string {
  refreshIfStale(deps)
  const { active, acked } = lintNow(deps)
  const important = active.filter((finding) => finding.severity !== 'low')
  writeJson(deps.p.notified, remember([], active, important))
  const missing = loadSnapshot(deps.p) === null ? `\n(ボードの控えがまだ無い。取得中。数十秒後に ${SCRUM_CLI} lint で確かめられる)` : ''
  return formatSummary(active, acked.length) + missing
}

/** 前に知らせてから新しく出た中以上の指摘だけを入れる。 */
export function techleadDiff(deps: HookDeps): string {
  rmSync(deps.p.pending, { force: true })
  const { active } = lintNow(deps)
  const fresh = unseen(active, readJson<readonly string[]>(deps.p.notified, []), 'medium')
  if (fresh.length === 0) return ''
  markNotified(deps, active, fresh)
  return ['scrum-harness: 新しい指摘', ...formatList(fresh, INJECT_LIMIT)].join('\n')
}

function touchedLabels(commands: readonly BoardCommand[]): ReadonlySet<string> {
  return new Set(
    commands.flatMap((command) => {
      if (command.kind === 'bulk-status') return command.labels
      return command.kind === 'raw-mutation' ? [] : [command.label]
    }),
  )
}

function mergeNotes(deps: HookDeps, commands: readonly BoardCommand[]): readonly string[] {
  const snapshot = loadSnapshot(deps.p)
  if (snapshot === null) return []
  return commands.flatMap((command) => {
    if (command.kind !== 'merge-pr') return []
    const body = deps.fetchPrBody(command.label, command.repo)
    if (body === null) return []
    const repo = command.repo
    const note = mergeContext(snapshot, command.label, referencedLabels(body, repo), deps.config)
    return note === null ? [] : [note]
  })
}

/** ボードを触るコマンドの後: 控えを直し、触った issue の指摘とマージの案内を入れる。 */
export function techleadAfterBash(deps: HookDeps, command: string): string {
  const commands = parseBoardCommands(command, deps.config)
  if (commands.length === 0) return techleadDiff(deps)
  const snapshot = loadSnapshot(deps.p)
  if (snapshot !== null) saveSnapshot(deps.p, applyCommands(snapshot, commands, deps.config, deps.now.toISOString().slice(0, 10)))
  if (commands.some((one) => one.kind === 'raw-mutation')) deps.spawnRefresh()
  const touched = touchedLabels(commands)
  const { active } = lintNow(deps)
  const related = active.filter((finding) => touched.has(finding.subject) || finding.rule === 'B-WIP-OVER')
  const notes = mergeNotes(deps, commands)
  markNotified(deps, active, related)
  const relatedText = related.length > 0 ? ['scrum-harness: 今触った issue の指摘', ...formatList(related, INJECT_LIMIT)] : []
  const rest = techleadDiff(deps)
  return [...relatedText, ...notes, ...(rest === '' ? [] : [rest])].join('\n')
}

/** 止めたことのない高い指摘が残っていれば、ターンの終わりを一度だけ止める。 */
export function techleadStop(deps: HookDeps, isStopHookActive: boolean): string | null {
  if (!deps.config.isStopBlockEnabled) return null
  const { active } = lintNow(deps)
  const high = active.filter((finding) => finding.severity === 'high')
  const decision = decideStop(high, readJson<readonly string[]>(deps.p.blocked, []), isStopHookActive)
  if (!isStopHookActive) writeJson(deps.p.blocked, decision.keys)
  if (!decision.shouldBlock) return null
  markNotified(deps, active, high)
  recordEvent(deps, 'stop-blocked', { keys: decision.keys })
  return [
    'scrum-harness: 終える前に、次の高い指摘を片付けるか、意図したものなら受け入れを記録する (同じ組み合わせでは二度止めない)',
    ...formatList(high, 10),
  ].join('\n')
}
