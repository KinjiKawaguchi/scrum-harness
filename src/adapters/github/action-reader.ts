import type { BoardCommand } from '../../board/commands.ts'
import { shortRepo, type BoardScripts, type Config } from '../../config.ts'
import type { ActionReader } from '../../ports/index.ts'
import { programAndArgs, splitCommands } from './shell-words.ts'

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

/** Bash から gh と設定のスクリプトでボードを書き換えるときの読み取り。 */
export function bashActionReader(config: Config): ActionReader {
  return { commandsOf: (command) => parseBoardCommands(command, config), shellPatterns: () => shellPatterns(config) }
}
