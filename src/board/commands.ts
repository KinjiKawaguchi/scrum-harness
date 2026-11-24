import { shortRepo, type BoardScripts, type Config } from '../config.ts'
import { label } from './rules.ts'
import { programAndArgs, splitCommands } from './shell.ts'
import type { BoardItem, Snapshot } from './types.ts'

export type BoardCommand =
  | { readonly kind: 'set-status'; readonly label: string; readonly status: string }
  | { readonly kind: 'set-reason'; readonly label: string; readonly reason: string; readonly since: string | null }
  | { readonly kind: 'set-tanto'; readonly label: string; readonly tanto: string | null }
  | { readonly kind: 'bulk-status'; readonly labels: readonly string[]; readonly status: string }
  /** repo は、コマンドが指したリポジトリの full の名前 (owner/name)。ラベルの短い名前から引き直すと、設定に無いリポジトリを defaultRepo と取り違える */
  | { readonly kind: 'merge-pr'; readonly label: string; readonly repo: string }
  | { readonly kind: 'close-issue'; readonly label: string }
  | { readonly kind: 'raw-mutation' }

const STATUS_ALIASES: Readonly<Record<string, keyof Config['statuses']>> = {
  Backlog: 'backlog',
  Next: 'next',
  InProgress: 'doing',
  Release: 'release',
  Done: 'done',
}

function normalizeStatus(value: string | undefined, config: Config): string | null {
  if (value === undefined) return null
  const alias = STATUS_ALIASES[value]
  if (alias !== undefined) return config.statuses[alias]
  return Object.values(config.statuses).includes(value) ? value : null
}

function normalizeReason(value: string | undefined, config: Config): string | null {
  if (value === undefined) return null
  return value === 'None' ? config.reasonNone : value
}

function repoOption(args: readonly string[], config: Config): string {
  const index = args.findIndex((arg) => arg === '-R' || arg === '--repo')
  return (index === -1 ? undefined : args[index + 1]) ?? config.defaultRepo
}

function numbered(repo: string, value: string | undefined): string | null {
  return value !== undefined && /^\d+$/.test(value) ? `${shortRepo(repo)}#${value}` : null
}

type ScriptKey = Exclude<keyof BoardScripts, 'clearValue'>

const SCRIPT_KEYS: readonly ScriptKey[] = ['setStatus', 'setReason', 'setTanto', 'bulkStatus', 'mergePr']

const baseName = (name: string): string => name.split('/').pop() ?? name

/** 実行したプログラムが、設定のどのスクリプトか。 */
function scriptOf(program: string, scripts: BoardScripts): ScriptKey | null {
  return SCRIPT_KEYS.find((key) => scripts[key] !== undefined && baseName(scripts[key] ?? '') === program) ?? null
}

function parseScript(key: ScriptKey, args: readonly string[], config: Config): BoardCommand | null {
  const issueLabel = numbered(config.defaultRepo, args[0])
  switch (key) {
    case 'setStatus': {
      const status = normalizeStatus(args[1], config)
      return issueLabel && status ? { kind: 'set-status', label: issueLabel, status } : null
    }
    case 'setReason': {
      const reason = normalizeReason(args[1], config)
      return issueLabel && reason ? { kind: 'set-reason', label: issueLabel, reason, since: args[2] ?? null } : null
    }
    case 'setTanto': {
      const tanto = args[1] === config.scripts.clearValue ? null : (args[1] ?? null)
      return issueLabel && args[1] ? { kind: 'set-tanto', label: issueLabel, tanto } : null
    }
    case 'bulkStatus': {
      const status = normalizeStatus(args[0], config)
      return status ? { kind: 'bulk-status', labels: args.slice(1), status } : null
    }
    case 'mergePr': {
      const repo = args[0] ?? config.defaultRepo
      const prLabel = numbered(repo, args[1])
      return prLabel ? { kind: 'merge-pr', label: prLabel, repo } : null
    }
  }
}

function parseSegment(words: readonly string[], config: Config): BoardCommand | null {
  const { program, args } = programAndArgs(words)
  if (program === 'gh') return parseGh(args, config)
  const key = scriptOf(program, config.scripts)
  return key === null ? null : parseScript(key, args, config)
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * bin/scrum が node を起こすかを決める型 (grep -E)。post はツールの呼び出しの後に見るコマンド、
 * pre は書き込みの前に確かめるコマンド (Status を変えるスクリプト)。pre が空なら確かめない。
 */
export function shellPatterns(config: Config): { readonly post: string; readonly pre: string } {
  const names = (keys: readonly ScriptKey[]) =>
    keys.flatMap((key) => (config.scripts[key] === undefined ? [] : [escapeRegExp(baseName(config.scripts[key] ?? ''))]))
  return {
    post: [...names(SCRIPT_KEYS), 'gh pr merge', 'gh issue close', 'gh project', 'ProjectV2'].join('|'),
    pre: names(['setStatus', 'bulkStatus']).join('|'),
  }
}

function parseGh(args: readonly string[], config: Config): BoardCommand | null {
  const repo = repoOption(args, config)
  const target = numbered(repo, args[2])
  if (args[0] === 'pr' && args[1] === 'merge') return target ? { kind: 'merge-pr', label: target, repo } : null
  if (args[0] === 'issue' && args[1] === 'close') return target ? { kind: 'close-issue', label: target } : null
  if (args[0] === 'project' && args[1] === 'item-edit') return { kind: 'raw-mutation' }
  return null
}

const RAW_MUTATION = /(update|clear)ProjectV2ItemFieldValue/

export function parseBoardCommands(command: string, config: Config): readonly BoardCommand[] {
  const parsed = splitCommands(command).flatMap((words) => {
    const one = parseSegment(words, config)
    return one === null ? [] : [one]
  })
  const hasRaw = RAW_MUTATION.test(command) && !parsed.some((one) => one.kind === 'raw-mutation')
  return hasRaw ? [...parsed, { kind: 'raw-mutation' }] : parsed
}

function newIssue(itemLabel: string, config: Config): BoardItem {
  const [repoName = '', number = '0'] = itemLabel.split('#')
  const repo = config.repos.find((full) => shortRepo(full) === repoName) ?? config.defaultRepo
  return {
    itemId: '', kind: 'issue', repo, number: Number(number), title: '', state: 'OPEN', author: null,
    status: null, reason: null, since: null, owner: null, tanto: null,
  }
}

function patchItem(snapshot: Snapshot, itemLabel: string, patch: Partial<BoardItem>, config: Config, isAddable: boolean): Snapshot {
  const exists = snapshot.items.some((item) => label(item) === itemLabel)
  if (!exists && !isAddable) return snapshot
  const items = exists ? snapshot.items : [...snapshot.items, newIssue(itemLabel, config)]
  return { ...snapshot, items: items.map((item) => (label(item) === itemLabel ? { ...item, ...patch } : item)) }
}

function applyOne(snapshot: Snapshot, command: BoardCommand, config: Config, today: string): Snapshot {
  switch (command.kind) {
    case 'set-status':
      return patchItem(snapshot, command.label, { status: command.status }, config, true)
    case 'set-reason': {
      const since = command.reason === config.reasonNone ? null : (command.since ?? today)
      return patchItem(snapshot, command.label, { reason: command.reason, since }, config, false)
    }
    case 'set-tanto':
      return patchItem(snapshot, command.label, { tanto: command.tanto }, config, true)
    case 'bulk-status':
      return command.labels.reduce((acc, one) => patchItem(acc, one, { status: command.status }, config, false), snapshot)
    case 'merge-pr':
      return patchItem(snapshot, command.label, { state: 'MERGED' }, config, false)
    case 'close-issue':
      return patchItem(snapshot, command.label, { state: 'CLOSED' }, config, false)
    case 'raw-mutation':
      return snapshot
  }
}

/** コマンドが成功したとみなして、取り直しを待たずに控えへ反映する。 */
export function applyCommands(snapshot: Snapshot, commands: readonly BoardCommand[], config: Config, today: string): Snapshot {
  return commands.reduce((acc, command) => applyOne(acc, command, config, today), snapshot)
}

function statusTargets(commands: readonly BoardCommand[]): readonly { readonly label: string; readonly status: string }[] {
  return commands.flatMap((command) => {
    if (command.kind === 'set-status') return [{ label: command.label, status: command.status }]
    if (command.kind === 'bulk-status') return command.labels.map((one) => ({ label: one, status: command.status }))
    return []
  })
}

const isDoingIssue = (item: BoardItem | undefined, config: Config): boolean =>
  item?.kind === 'issue' && item.state === 'OPEN' && item.status === config.statuses.doing

/** 作業中の issue の数。作業中の上限の守り (checkGuard) と、渡す側 (chooseNext) が、同じ数え方を使う (除く作者の issue も数える)。 */
export function countDoing(snapshot: Snapshot, config: Config): number {
  return snapshot.items.filter((item) => isDoingIssue(item, config)).length
}

/** 書き込みの前に、作ってはいけない状態 (作業中の上限超え、PR の Status) を止める。止める理由か null を返す。 */
export function checkGuard(snapshot: Snapshot, commands: readonly BoardCommand[], config: Config, rawCommand = ''): string | null {
  if (rawCommand.includes('SCRUM_GUARD=off')) return null
  const byLabel = new Map(snapshot.items.map((item) => [label(item), item]))
  const targets = statusTargets(commands)
  const prTarget = targets.find((target) => byLabel.get(target.label)?.kind === 'pr')
  if (prTarget !== undefined) {
    return `${prTarget.label} は PR。PR に Status を付けない。issue の番号か確かめる`
  }
  const current = countDoing(snapshot, config)
  const added = new Set(targets.filter((t) => t.status === config.statuses.doing && !isDoingIssue(byLabel.get(t.label), config)).map((t) => t.label)).size
  if (added === 0 || current + added <= config.wipLimit) return null
  return `作業中は ${current} 件で上限 ${config.wipLimit}。新しく着手する前に、止まっているものから見直してバックログに戻す。意図して超えるなら SCRUM_GUARD=off を付けて理由を記録に残す`
}

const REFERENCE = /(?<![\w/.#-])(?:([A-Za-z0-9_.-]+)#|#)(\d+)/g

/** PR の本文から issue への言及 (#番号、リポジトリ名#番号) を拾う。 */
export function referencedLabels(body: string, repo: string): readonly string[] {
  const labels = [...body.matchAll(REFERENCE)].map((match) => `${match[1] ?? shortRepo(repo)}#${match[2]}`)
  return [...new Set(labels)]
}

export function mergeContext(snapshot: Snapshot, prLabel: string, refs: readonly string[], config: Config): string | null {
  const issues = snapshot.items.filter((item) => item.kind === 'issue' && refs.includes(label(item)))
  if (issues.length === 0) return null
  const lines = issues.map(
    (item) =>
      `- ${label(item)} Status=${item.status ?? '空'} 理由=${item.reason ?? '空'} 担当=${item.tanto ?? 'なし'} (${item.state === 'CLOSED' ? '閉じている' : '開いている'})`,
  )
  return [
    `${prLabel} をマージした。本文が触れているボードの issue:`,
    ...lines,
    `作業の PR で残りがリリースだけなら ${config.statuses.release}、閉じたら ${config.statuses.done}。担当が手を離したら担当も直す。`,
  ].join('\n')
}
