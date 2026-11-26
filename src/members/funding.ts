import type { Config } from '../config.ts'
import { expandHome } from '../paths.ts'
import type { FundingPick, FundingTool, Ports } from '../ports/index.ts'
import { readJson, writeJson } from '../store.ts'
import type { MemberSpec } from './config.ts'

/** Which account a member started on, kept so `member list` can show it. */
export type MemberSource = {
  readonly name: string
  /** Empty when the member was refused */
  readonly source: string
  /** `refused`: the member was not started (every source at its limit, or the picked login has no harness hooks) */
  readonly state: FundingPick['state'] | 'refused'
  readonly at: string
  readonly reason?: string
  /** The session the member was running when it was adopted, so that `start --resume` can find it after it exits */
  readonly sessionId?: string
}

export const readMemberSources = (path: string): readonly MemberSource[] => readJson<readonly MemberSource[]>(path, [])

export function recordMemberSource(path: string, entry: MemberSource): void {
  writeJson(path, [...readMemberSources(path).filter((one) => one.name !== entry.name), entry])
}

export function forgetMemberSource(path: string, name: string): void {
  const rest = readMemberSources(path).filter((one) => one.name !== name)
  if (rest.length !== readMemberSources(path).length) writeJson(path, rest)
}

/** The tool a member's product draws on, as the node's funding sources name it. */
export const toolOf = (spec: MemberSpec): FundingTool => (spec.product === 'codex' ? 'codex' : 'claude')

/** A Claude Code member with its own `configDir` is pinned to that login, and the pick is skipped for it. */
export const isPinned = (spec: MemberSpec): boolean => spec.product !== 'codex' && spec.configDir !== undefined

export type FundingOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'picked'; readonly pick: FundingPick }
  | { readonly kind: 'none'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'unguarded'; readonly reason: string }

/**
 * Asks the node which account the member's session should run under. Skipped without a funding command or for a pinned member. `none` (every source is at
 * its real limit) means the member is not started. A pick that cannot be asked or answered is `failed`: the member then starts on its own settings, because a
 * node that is down must not stop the team.
 */
export function pickFor(ports: Ports, spec: MemberSpec): FundingOutcome {
  if (ports.funding === null || isPinned(spec)) return { kind: 'skipped' }
  try {
    const pick = ports.funding(toolOf(spec))
    if (pick.state === 'none') return { kind: 'none', reason: pick.reason ?? 'every funding source is at its limit' }
    const unguarded = missingHooksReason(ports, spec, pick)
    return unguarded === null ? { kind: 'picked', pick } : { kind: 'unguarded', reason: unguarded }
  } catch (error) {
    return { kind: 'failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) }
  }
}

/**
 * Why a Claude Code member must not start under the picked login, or null. A session under the login runs only the hooks of that directory's settings. Without the harness's hooks the write guard and the watchdog
 * do not see the member, so it is not started; the harness does not install them, since that edits another account's settings.
 */
export function missingHooksReason(ports: Ports, spec: MemberSpec, pick: FundingPick): string | null {
  const dir = pick.env.CLAUDE_CONFIG_DIR
  if (spec.product === 'codex' || dir === undefined || ports.hasHooksIn(expandHome(dir))) return null
  return `source ${pick.source ?? 'picked'} (${dir}) has no harness hooks, so a member there would run unguarded and unwatched; run \`scrum install --dir ${dir}\` and start it again`
}

/** The words that say which source a member runs on, for the line a start prints. */
export function describePick(pick: FundingPick): string {
  const label = pick.state === 'overThreshold' ? 'every source is past its threshold; the one with most room' : pick.state === 'unknown' ? 'usage unknown' : 'under its threshold'
  return `on source ${pick.source ?? 'the default'} (${label}${pick.reason === undefined ? '' : `: ${pick.reason}`})`
}

export const hasFunding = (config: Config): boolean => config.launch?.funding !== undefined
