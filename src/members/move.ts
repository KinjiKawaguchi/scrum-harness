import type { Flags } from '../cli-commands.ts'
import type { Config } from '../config.ts'
import { stateDir } from '../config.ts'
import { expandHome } from '../paths.ts'
import type { FundingPick, FundingSource, Ports } from '../ports/index.ts'
import type { SessionSignal } from '../team/types.ts'
import { baseName } from '../usage/attribution.ts'
import { readJson, writeJson } from '../store.ts'
import { writeOver, type LeftOver } from './over-threshold.ts'
import { missingHooksReason, readMemberSources, recordMemberSource, type MemberSource } from './funding.ts'
import { finishExit, startWatched, type WatchdogDeps } from './lifecycle.ts'
import { memberReport, type MemberRow } from './list.ts'
import { planMember, specOf, type Planned } from './plan.ts'
import { watchdogOf } from './watchdog.ts'

/** A member has to have been idle this long before it is restarted: a turn that ended a moment ago may be followed by the next one. */
const IDLE_SECONDS = 60

/** What a moved member reads first: the conversation continues, and nothing else changes. */
const HANDOFF = 'You were moved to another login because the one you ran on is past its weekly threshold. Nothing else changed: carry on with what you were doing.'

type Move = { readonly sessionId: string; readonly from: FundingSource; readonly to: FundingPick }
/** `over` is the source the member runs on when that source is past its threshold (or blocked), also when the member cannot be moved off it now. */
type Judgement = { readonly name: string; readonly reason: string; readonly move?: Move; readonly over?: string }

type Facts = {
  readonly config: Config
  readonly ports: Ports
  readonly pick: FundingPick
  readonly sources: readonly FundingSource[]
  readonly recorded: readonly MemberSource[]
  readonly signals: readonly SessionSignal[]
  readonly now: Date
  /** Names of the members that were refused by their source (a usage-limit refusal): their source counts as blocked and they need not have been idle */
  readonly refused: ReadonlySet<string>
}

/** The live session of a member, the latest when several answer to the name. */
function liveSignal(signals: readonly SessionSignal[], name: string): SessionSignal | undefined {
  return signals.filter((signal) => signal.isAlive && signal.state !== 'ended' && baseName(signal.name) === name).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

const isIdleLongEnough = (signal: SessionSignal, now: Date): boolean => signal.state === 'idle' && Date.parse(signal.since) <= now.getTime() - IDLE_SECONDS * 1000

/** Why a member's source is not a reason to move it, or the source it is on; `stay` in the first slot when it is not one. A source that refused the member counts as blocked. */
function sourceVerdict(facts: Facts, name: string): { readonly stay: string } | { readonly from: FundingSource } {
  const recorded = facts.recorded.find((one) => one.name === name)
  if (recorded === undefined || recorded.state === 'refused' || recorded.source === '') return { stay: 'no record of the source it started on (it was not started by `scrum member start`)' }
  const from = facts.sources.find((source) => source.source === recorded.source)
  if (from === undefined) return { stay: `its source ${recorded.source} is not in the node's list` }
  if (facts.refused.has(name)) return { from }
  if (from.unknown === true) return { stay: `the node cannot read the usage of ${from.source} right now, so it stays where it is` }
  if (from.overThreshold === undefined && from.blocked === undefined) return { stay: `the node does not say whether ${from.source} is past its threshold` }
  if (from.overThreshold !== true && from.blocked !== true) return { stay: `${from.source} is still under its threshold` }
  return { from }
}

/** Whether one member should move to the picked source now, and if not, why not. Pure. */
function judge(facts: Facts, row: MemberRow | undefined, name: string): Judgement {
  const spec = specOf(facts.config, name)
  const stay = (reason: string): Judgement => ({ name, reason })
  if (row === undefined || !row.isRunning) return stay('does not run')
  if (spec.product === 'codex') return stay('a Codex member is not moved (its sessions are under CODEX_HOME)')
  if (spec.configDir !== undefined) return stay(`it is pinned to ${spec.configDir}`)
  const verdict = sourceVerdict(facts, name)
  if ('stay' in verdict) return stay(verdict.stay)
  const { from } = verdict
  const stayOver = (reason: string): Judgement => ({ name, reason, over: from.source })
  if (facts.pick.state !== 'ok') return stayOver(`${from.source} is past its threshold, and there is no better source (the node says ${facts.pick.state})`)
  if (facts.pick.source === from.source) return stayOver(`already on ${from.source}`)
  const hooks = missingHooksReason(facts.ports, spec, facts.pick)
  if (hooks !== null) return stayOver(hooks)
  const signal = liveSignal(facts.signals, name)
  if (signal === undefined) return stayOver('has no live session record')
  if (!facts.refused.has(name) && !isIdleLongEnough(signal, facts.now)) return stayOver(`not idle for ${IDLE_SECONDS} seconds (${signal.state}); left for the next call`)
  const target = expandHome(facts.pick.env.CLAUDE_CONFIG_DIR ?? '~/.claude')
  if (!facts.ports.hasTranscriptIn(target, signal.sessionId)) return stayOver(`its conversation is not visible under ${target}; link that directory's projects to the first login's, so --resume finds it`)
  const why = facts.refused.has(name) ? `${from.source} refused it (usage limit)` : `${from.source} is past its threshold`
  return { name, reason: `${why}; ${facts.pick.source ?? 'the picked source'} is not`, over: from.source, move: { sessionId: signal.sessionId, from, to: facts.pick } }
}

const planFor = (config: Config, ports: Ports, name: string, env: Readonly<Record<string, string>>, sessionId: string): Planned =>
  planMember(config, name, stateDir(), process.env.PATH, ports.launchers, { pickedEnv: env, resume: { sessionId, note: HANDOFF } })

/** Starts the plan the way a start does: watched when the member has a watchdog. Throws when the host refuses. */
function startPlanned(ports: Ports, session: string, planned: Extract<Planned, { plan: unknown }>, deps: WatchdogDeps): boolean {
  const watchdog = watchdogOf(planned.spec)
  if (watchdog !== null) return startWatched(ports, session, planned.plan, planned.spec, watchdog, deps).isStarted
  ports.members.start(session, planned.plan)
  return true
}

/** What one move came to: the line to print, and whether the member now runs on the picked source. */
type Executed = { readonly text: string; readonly isMoved: boolean }

/** Restarts a member on the picked source, continuing its conversation; on the old source again when that does not come up. A refused member need not be idle. */
function execute(facts: Facts, session: string, name: string, move: Move, deps: WatchdogDeps): Executed {
  const current = liveSignal(deps.signals(), name)
  if (current === undefined || (!facts.refused.has(name) && !isIdleLongEnough(current, deps.now()))) return { text: `${name}: became busy; not moved`, isMoved: false }
  facts.ports.members.stop(session, name, 'graceful')
  const exit = finishExit(facts.ports, session, name, deps)
  if (!exit.isExited) return { text: `${name}: ${exit.text}; not moved`, isMoved: false }
  const attempt = (env: Readonly<Record<string, string>>): string | null => {
    try {
      const planned = planFor(facts.config, facts.ports, name, env, move.sessionId)
      if ('problem' in planned) return planned.problem
      return startPlanned(facts.ports, session, planned, deps) ? null : 'it showed no sign of life'
    } catch (error) {
      return (error instanceof Error ? error.message : String(error)).slice(0, 200)
    }
  }
  const to = move.to.source ?? 'the picked source'
  const failure = attempt(move.to.env)
  if (failure === null) {
    if (deps.memberSourcesPath !== undefined) recordMemberSource(deps.memberSourcesPath, { name, source: to, state: move.to.state, at: deps.now().toISOString() })
    return { text: `${name}: moved from ${move.from.source} to ${to}, conversation continued`, isMoved: true }
  }
  const rollback = attempt(move.from.env)
  return { text: rollback === null ? `${name}: did not come up on ${to} (${failure}); started again on ${move.from.source}` : `${name}: did not come up on ${to} (${failure}), and not on ${move.from.source} either (${rollback}); look at the tmux session`, isMoved: false }
}

/**
 * `scrum member move [<name>...] [--dry-run] [--refused]`: moves every member that runs on a source past its threshold to the source the node picks, one after
 * another, each at an idle moment, by restarting it with `--resume` on the new login. Without names it looks at the members (not the lead). Nothing is moved
 * on --dry-run. With --refused the named members were refused by their source (a usage-limit refusal): that source counts as blocked, and they are moved
 * at once, idle or not.
 */
export function moveCommand(config: Config, ports: Ports, positional: readonly string[], flags: Flags, deps: WatchdogDeps | undefined): string {
  if (flags.refused === true && flags['dry-run'] !== true && deps !== undefined && positional.length > 1) return positional.slice(1).map((name) => moveRefused(config, ports, name, deps)).join('\n')
  return runMove(config, ports, positional, flags, deps).text
}

type MoveRun = { readonly text: string; /** Whether a member was asked to exit (a move was tried) */ readonly isAttempted: boolean; /** The members still on a source past its threshold */ readonly left: readonly LeftOver[]; /** Whether the node could be asked at all */ readonly isKnown: boolean }

/** A member whose move was tried less than this long ago is not tried again by the automatic move or by a refusal: a source that hovers or refuses must not cause a string of restarts. */
const RETRY_MINUTES = 10

type Tries = Readonly<Record<string, string>>
const readTries = (path: string | undefined): Tries => (path === undefined ? {} : (readJson<{ readonly members?: Tries }>(path, {}).members ?? {}))
const writeTries = (path: string | undefined, tries: Tries): void => {
  if (path !== undefined) writeJson(path, { members: tries })
}

type RunOptions = { readonly isGuarded: boolean }

function runMove(config: Config, ports: Ports, positional: readonly string[], flags: Flags, deps: WatchdogDeps | undefined, options: RunOptions = { isGuarded: false }): MoveRun {
  const say = (text: string): MoveRun => ({ text, isAttempted: false, left: [], isKnown: false })
  const launch = config.launch
  if (launch === undefined || ports.funding === null || ports.fundingSources === null) return say('moving a member needs a launch section and launch.funding in the configuration')
  const report = memberReport(config, ports.members.windows(launch.tmuxSession), ports.sessions.signals())
  const named = positional.slice(1)
  const wanted = named.length > 0 ? named : report.rows.filter((row) => row.role === 'member' && launch.members[row.name] !== undefined).map((row) => row.name)
  const unknown = wanted.filter((name) => !report.rows.some((row) => row.name === name))
  if (unknown.length > 0) return say(`not in the configuration (the lead, the members, or the liaison): ${unknown.join(', ')}`)
  let facts: Facts
  try {
    facts = { config, ports, pick: ports.funding('claude'), sources: ports.fundingSources(), recorded: deps?.memberSourcesPath === undefined ? [] : readMemberSources(deps.memberSourcesPath), signals: ports.sessions.signals(), now: deps?.now() ?? new Date(), refused: new Set(flags.refused === true ? named : []) }
  } catch (error) {
    return say(`the node cannot be asked, so nothing is moved: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`)
  }
  const judgements = wanted.map((name) => judge(facts, report.rows.find((row) => row.name === name), name))
  const isDry = flags['dry-run'] === true
  const tries = options.isGuarded ? readTries(deps?.memberMovesPath) : {}
  const isRecent = (name: string): boolean => {
    const at = tries[name]
    return at !== undefined && facts.now.getTime() - Date.parse(at) < RETRY_MINUTES * 60_000
  }
  const lines: string[] = []
  const left: LeftOver[] = []
  let isAttempted = false
  let nextTries = tries
  for (const one of judgements) {
    if (one.move === undefined) {
      lines.push(`${one.name}: stays: ${one.reason}`)
      if (one.over !== undefined) left.push({ name: one.name, source: one.over, reason: one.reason })
      continue
    }
    if (isRecent(one.name)) {
      const reason = `its move was tried less than ${RETRY_MINUTES} minutes ago; left for a later call`
      lines.push(`${one.name}: stays: ${reason}`)
      left.push({ name: one.name, source: one.over ?? one.move.from.source, reason })
      continue
    }
    if (isDry) {
      lines.push(`${one.name}: would move: ${one.reason}`)
      left.push({ name: one.name, source: one.move.from.source, reason: `would move: ${one.reason}` })
      continue
    }
    if (deps === undefined) {
      lines.push(`${one.name}: moves: ${one.reason}`, 'moving needs the clock and the session records, which only the command line has')
      continue
    }
    lines.push(`${one.name}: moves: ${one.reason}`)
    const done = execute(facts, launch.tmuxSession, one.name, one.move, deps)
    lines.push(done.text)
    isAttempted = true
    nextTries = { ...nextTries, [one.name]: deps.now().toISOString() }
    if (!done.isMoved) left.push({ name: one.name, source: one.move.from.source, reason: done.text.slice(one.name.length + 2) })
  }
  if (isAttempted && options.isGuarded) writeTries(deps?.memberMovesPath, nextTries)
  if (judgements.every((one) => one.move === undefined)) lines.push('nothing to move')
  return { text: lines.join('\n'), isAttempted, left, isKnown: true }
}

/**
 * The automatic move, called by `scrum refresh`: every member that runs on a source past its threshold (or blocked) is moved to the source the node picks,
 * one after another, when `launch.funding.autoMove` is true; a member whose move was tried less than 10 minutes ago is left for a later call. Whatever is
 * left on a source past its threshold, with the time since it was first seen so, is kept for the finding M-OVER-THRESHOLD, also when autoMove is off.
 * Returns the text to print, or null when there was nothing to move or say.
 */
export function autoMove(config: Config, ports: Ports, deps: WatchdogDeps): string | null {
  if (config.launch?.funding === undefined) return null
  const run = runMove(config, ports, ['move'], config.launch.funding.autoMove === true ? {} : { 'dry-run': true }, deps, { isGuarded: true })
  if (run.isKnown && deps.memberOverPath !== undefined) writeOver(deps.memberOverPath, run.left, deps.now())
  return run.isAttempted ? `automatic move: ${run.text}` : null
}

/** A usage-limit refusal of a member: moves it at once, off the source that refused it. Returns the text to print. */
export function moveRefused(config: Config, ports: Ports, name: string, deps: WatchdogDeps): string {
  const run = runMove(config, ports, ['move', name], { refused: true }, deps, { isGuarded: true })
  if (run.isKnown && deps.memberOverPath !== undefined) writeOver(deps.memberOverPath, run.left, deps.now(), name)
  return run.text
}
