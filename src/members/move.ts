import type { Flags } from '../cli-commands.ts'
import type { Config } from '../config.ts'
import { stateDir } from '../config.ts'
import { expandHome } from '../paths.ts'
import type { FundingPick, FundingSource, Ports } from '../ports/index.ts'
import type { SessionSignal } from '../team/types.ts'
import { baseName } from '../usage/attribution.ts'
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
type Judgement = { readonly name: string; readonly reason: string; readonly move?: Move }

type Facts = {
  readonly config: Config
  readonly ports: Ports
  readonly pick: FundingPick
  readonly sources: readonly FundingSource[]
  readonly recorded: readonly MemberSource[]
  readonly signals: readonly SessionSignal[]
  readonly now: Date
}

/** The live session of a member, the latest when several answer to the name. */
function liveSignal(signals: readonly SessionSignal[], name: string): SessionSignal | undefined {
  return signals.filter((signal) => signal.isAlive && signal.state !== 'ended' && baseName(signal.name) === name).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

const isIdleLongEnough = (signal: SessionSignal, now: Date): boolean => signal.state === 'idle' && Date.parse(signal.since) <= now.getTime() - IDLE_SECONDS * 1000

/** Why a member's source is not a reason to move it, or the source it is on; null in the first slot when it is one. */
function sourceVerdict(facts: Facts, name: string): { readonly stay: string } | { readonly from: FundingSource } {
  const recorded = facts.recorded.find((one) => one.name === name)
  if (recorded === undefined || recorded.state === 'refused' || recorded.source === '') return { stay: 'no record of the source it started on (it was not started by `scrum member start`)' }
  const from = facts.sources.find((source) => source.source === recorded.source)
  if (from === undefined) return { stay: `its source ${recorded.source} is not in the node's list` }
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
  if (facts.pick.state !== 'ok') return stay(`${from.source} is past its threshold, and there is no better source (the node says ${facts.pick.state})`)
  if (facts.pick.source === from.source) return stay(`already on ${from.source}`)
  const hooks = missingHooksReason(facts.ports, spec, facts.pick)
  if (hooks !== null) return stay(hooks)
  const signal = liveSignal(facts.signals, name)
  if (signal === undefined) return stay('has no live session record')
  if (!isIdleLongEnough(signal, facts.now)) return stay(`not idle for ${IDLE_SECONDS} seconds (${signal.state}); left for the next call`)
  const target = expandHome(facts.pick.env.CLAUDE_CONFIG_DIR ?? '~/.claude')
  if (!facts.ports.hasTranscriptIn(target, signal.sessionId)) return stay(`its conversation is not visible under ${target}; link that directory's projects to the first login's, so --resume finds it`)
  return { name, reason: `${from.source} is past its threshold; ${facts.pick.source ?? 'the picked source'} is not`, move: { sessionId: signal.sessionId, from, to: facts.pick } }
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

/** Restarts a member that is idle on the picked source, continuing its conversation; on the old source again when that does not come up. */
function execute(facts: Facts, session: string, name: string, move: Move, deps: WatchdogDeps): string {
  const current = liveSignal(deps.signals(), name)
  if (current === undefined || !isIdleLongEnough(current, deps.now())) return `${name}: became busy; not moved`
  facts.ports.members.stop(session, name, 'graceful')
  const exit = finishExit(facts.ports, session, name, deps)
  if (!exit.isExited) return `${name}: ${exit.text}; not moved`
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
    return `${name}: moved from ${move.from.source} to ${to}, conversation continued`
  }
  const rollback = attempt(move.from.env)
  return rollback === null ? `${name}: did not come up on ${to} (${failure}); started again on ${move.from.source}` : `${name}: did not come up on ${to} (${failure}), and not on ${move.from.source} either (${rollback}); look at the tmux session`
}

/**
 * `scrum member move [<name>...] [--dry-run]`: moves ONE member that runs on a source past its threshold to the source the node picks, at an idle moment,
 * by restarting it with `--resume` on the new login. Without names it looks at the members (not the lead). Nothing is moved on --dry-run.
 */
export function moveCommand(config: Config, ports: Ports, positional: readonly string[], flags: Flags, deps: WatchdogDeps | undefined): string {
  const launch = config.launch
  if (launch === undefined || ports.funding === null || ports.fundingSources === null) return 'moving a member needs a launch section and launch.funding in the configuration'
  const report = memberReport(config, ports.members.windows(launch.tmuxSession), ports.sessions.signals())
  const named = positional.slice(1)
  const wanted = named.length > 0 ? named : report.rows.filter((row) => row.role === 'member' && launch.members[row.name] !== undefined).map((row) => row.name)
  const unknown = wanted.filter((name) => !report.rows.some((row) => row.name === name))
  if (unknown.length > 0) return `not in the configuration (the lead, the members, or the liaison): ${unknown.join(', ')}`
  let facts: Facts
  try {
    facts = { config, ports, pick: ports.funding('claude'), sources: ports.fundingSources(), recorded: deps?.memberSourcesPath === undefined ? [] : readMemberSources(deps.memberSourcesPath), signals: ports.sessions.signals(), now: deps?.now() ?? new Date() }
  } catch (error) {
    return `the node cannot be asked, so nothing is moved: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`
  }
  const judgements = wanted.map((name) => judge(facts, report.rows.find((row) => row.name === name), name))
  const first = judgements.find((one) => one.move !== undefined)
  const lines = judgements.map((one) => (one === first ? `${one.name}: ${flags['dry-run'] === true ? 'would move' : 'moves'}: ${one.reason}` : `${one.name}: stays: ${one.reason}${one.move === undefined ? '' : ' (one member is moved per call; this one is next)'}`))
  if (first?.move === undefined || flags['dry-run'] === true) return [...lines, ...(first === undefined ? ['nothing to move'] : [])].join('\n')
  if (deps === undefined) return [...lines, 'moving needs the clock and the session records, which only the command line has'].join('\n')
  return [...lines, execute(facts, launch.tmuxSession, first.name, first.move, deps)].join('\n')
}
