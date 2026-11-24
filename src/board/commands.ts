import { shortRepo, type Config } from '../config.ts'
import { label } from './rules.ts'
import type { BoardItem, Snapshot } from './types.ts'

export type BoardCommand =
  | { readonly kind: 'set-status'; readonly label: string; readonly status: string }
  | { readonly kind: 'set-reason'; readonly label: string; readonly reason: string; readonly since: string | null }
  | { readonly kind: 'set-assignee'; readonly label: string; readonly assignee: string | null }
  | { readonly kind: 'bulk-status'; readonly labels: readonly string[]; readonly status: string }
  /** repo is the full name (owner/name) of the repository the command pointed at. Looking it up again from the label's short name would mistake a repository not in the config for defaultRepo */
  | { readonly kind: 'merge-pr'; readonly label: string; readonly repo: string }
  | { readonly kind: 'close-issue'; readonly label: string }
  | { readonly kind: 'raw-mutation' }

function newIssue(itemLabel: string, config: Config): BoardItem {
  const [repoName = '', number = '0'] = itemLabel.split('#')
  const repo = config.repos.find((full) => shortRepo(full) === repoName) ?? config.defaultRepo
  return {
    itemId: '', kind: 'issue', repo, number: Number(number), title: '', state: 'OPEN', author: null,
    status: null, reason: null, since: null, owner: null, assignee: null,
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
    case 'set-assignee':
      return patchItem(snapshot, command.label, { assignee: command.assignee }, config, true)
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

/** Treats the command as having succeeded and reflects it in the board copy without waiting for a re-fetch. */
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

/** The number of In Progress issues. The In Progress limit guard (checkGuard) and the hand-over side (chooseNext) use the same way of counting (issues by excluded authors are also counted). */
export function countDoing(snapshot: Snapshot, config: Config): number {
  return snapshot.items.filter((item) => isDoingIssue(item, config)).length
}

/** Before a write, stops states that must not be created (exceeding the In Progress limit, the PR's Status). Returns the reason for stopping, or null. */
export function checkGuard(snapshot: Snapshot, commands: readonly BoardCommand[], config: Config, rawCommand = ''): string | null {
  if (rawCommand.includes('SCRUM_GUARD=off')) return null
  const byLabel = new Map(snapshot.items.map((item) => [label(item), item]))
  const targets = statusTargets(commands)
  const prTarget = targets.find((target) => byLabel.get(target.label)?.kind === 'pr')
  if (prTarget !== undefined) {
    return `${prTarget.label} is a PR. A PR must not have a Status. Check the issue number`
  }
  const current = countDoing(snapshot, config)
  const added = new Set(targets.filter((t) => t.status === config.statuses.doing && !isDoingIssue(byLabel.get(t.label), config)).map((t) => t.label)).size
  if (added === 0 || current + added <= config.wipLimit) return null
  return `${current} items are In Progress, at the limit of ${config.wipLimit}. Before starting another, review the blocked ones and move them back to Backlog. To exceed the limit on purpose, add SCRUM_GUARD=off and record the reason`
}

export function mergeContext(snapshot: Snapshot, prLabel: string, refs: readonly string[], config: Config): string | null {
  const issues = snapshot.items.filter((item) => item.kind === 'issue' && refs.includes(label(item)))
  if (issues.length === 0) return null
  const lines = issues.map(
    (item) =>
      `- ${label(item)} Status=${item.status ?? 'empty'} reason=${item.reason ?? 'empty'} assignee=${item.assignee ?? 'none'} (${item.state === 'CLOSED' ? 'closed' : 'open'})`,
  )
  return [
    `${prLabel} was merged. Board issues its body mentions:`,
    ...lines,
    `If the PR leaves only the release, set ${config.statuses.release}; once closed, ${config.statuses.done}. If the assignee lets go, update the assignee too.`,
  ].join('\n')
}
