import type { Config } from '../config.ts'
import type { Ports } from '../ports/index.ts'
import { stateDir } from '../config.ts'
import { formatReport, memberReport, runningVersions, waitingQuestions, type MemberReport } from './list.ts'
import { planMember, specOf } from './plan.ts'
import type { Flags } from '../cli-commands.ts'
import { refreshFundingDirs } from './funding-dirs.ts'
import { describePick, forgetMemberSource, pickFor, readMemberSources, recordMemberSource, type MemberSource } from './funding.ts'
import { budgetGate } from '../budget/gate.ts'
import { adoptCommand } from './adopt.ts'
import { moveCommand } from './move.ts'
import { RESTART_NOTE, recordedSessionId, resumeSession } from './resume.ts'
import { continueIdle } from './continue.ts'
import { finishExit, startWatched, type WatchdogDeps } from './lifecycle.ts'
import { watchdogOf } from './watchdog.ts'

export type { WatchdogDeps }

export const MEMBER_USAGE = `scrum member: the members of this team and where they run
  scrum member list                                  Each member in the configuration, whether it runs, and what runs but is not listed (or is listed and does not run)
  scrum member stop <name...> [--force]              Ask an idle member to exit. A busy member, or one at a permission prompt, only with --force, which closes its window
  scrum member adopt <name...> | --all [--source <name>]   Record members that already run (started some other way) as on the default login, or on the source named, without restarting them; needed by "member move"
  scrum member move [<name>...] [--dry-run]          With launch.funding: restart ONE idle member that runs on a source past its threshold on the source the node picks, continuing its conversation. Without names, the members (not the lead)
  scrum member continue [--dry-run]                  Type the continuation text of a Codex member into its window when it has been idle at its prompt for its afterMinutes (once for each stretch of idleness, not while an acknowledgement of its idleness is in force); scrum refresh does this too
  scrum member start <name...> | --all [--dry-run] [--no-wait] [--resume]   Start members in the tmux session of the launch section, from their settings; one that already runs is left alone. --dry-run prints what would run. A member with a startup watchdog (a Codex member by default) is waited for, closed, and started again if it shows no sign of life; --no-wait skips that. --resume continues the member's latest recorded Claude Code conversation (claude --resume) with a short note instead of its brief`

const shellWord = (word: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)

/** What would run, as text. The brief is shown as a placeholder: it can be long, and it is not for the screen. */
function describePlan(name: string, dir: string, env: Readonly<Record<string, string>>, argv: readonly string[], brief: string): string {
  const shown = argv.map((word) => (brief !== '' && word === brief ? `<brief: ${brief.length} characters>` : shellWord(word)))
  const vars = Object.entries(env).map(([key, value]) => `${key}=${key === 'PATH' ? '<this process\'s PATH>' : shellWord(value)}`)
  return `${name}: in ${dir}\n  env ${vars.join(' ')} ${shown.join(' ')}`
}

/** Starts one member that is not running: asks the node which account it runs under, plans the launch, and starts it (watched, where there is a watchdog). */
function startOne(config: Config, ports: Ports, name: string, session: string, flags: Flags, watchdogDeps: WatchdogDeps | undefined): string {
  const gate = budgetGate(config, ports, specOf(config, name), watchdogDeps?.budgetPath, watchdogDeps?.now() ?? new Date())
  if (gate.refusal !== undefined) return `${name}: not started: ${gate.refusal}`
  const outcome = pickFor(ports, specOf(config, name))
  const sourcesPath = watchdogDeps?.memberSourcesPath
  if (outcome.kind === 'none' || outcome.kind === 'unguarded') {
    if (flags['dry-run'] !== true) noteSource(sourcesPath, watchdogDeps, name, { source: '', state: 'refused', reason: outcome.reason })
    return `${name}: not started: ${outcome.reason}`
  }
  const pickedEnv = outcome.kind === 'picked' ? outcome.pick.env : {}
  const resumed = flags.resume === true ? resumeSession(ports, specOf(config, name), name, pickedEnv, { signals: watchdogDeps?.signals() ?? ports.sessions.signals(), recordedSessionId: recordedSessionId(watchdogDeps?.memberSourcesPath, name) }) : undefined
  if (resumed !== undefined && 'problem' in resumed) return `${name}: not started: ${resumed.problem}`
  const planned = planMember(config, name, stateDir(), process.env.PATH, ports.launchers, { pickedEnv, ...(gate.model === undefined ? {} : { model: gate.model }), ...(resumed === undefined ? {} : { resume: { sessionId: resumed.sessionId, note: RESTART_NOTE } }) })
  if ('problem' in planned) return `${name}: ${planned.problem}`
  const { plan, brief } = planned
  const budgetNote = gate.note === undefined ? '' : `\n${name}: ${gate.note}`
  const account = budgetNote + (outcome.kind === 'picked' ? `\n${name}: ${describePick(outcome.pick)}` : outcome.kind === 'failed' ? `\n${name}: the account could not be picked (${outcome.reason}); it starts on its own settings` : '')
  if (flags['dry-run'] === true) return describePlan(plan.name, plan.dir, plan.env, plan.argv, brief) + account
  try {
    if (outcome.kind === 'picked') noteSource(sourcesPath, watchdogDeps, name, { source: outcome.pick.source ?? '', state: outcome.pick.state })
    else if (sourcesPath !== undefined) forgetMemberSource(sourcesPath, name)
    const watchdog = watchdogOf(planned.spec)
    if (watchdog !== null && watchdogDeps !== undefined && flags['no-wait'] !== true) return startWatched(ports, session, plan, planned.spec, watchdog, watchdogDeps).text + account
    ports.members.start(session, plan)
    return `${name}: started in ${plan.dir}${account}`
  } catch (error) {
    return `${name}: could not start: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`
  }
}

function noteSource(path: string | undefined, deps: WatchdogDeps | undefined, name: string, entry: Pick<MemberSource, 'source' | 'state' | 'reason'>): void {
  if (path !== undefined && deps !== undefined) recordMemberSource(path, { name, at: deps.now().toISOString(), ...entry })
}

function startCommand(config: Config, ports: Ports, positional: readonly string[], flags: Flags, report: MemberReport, watchdogDeps: WatchdogDeps | undefined): string {
  const launch = config.launch
  if (launch === undefined) return 'there is no launch section in the configuration, so there is no tmux session to start members in'
  const known = report.rows.map((row) => row.name)
  const wanted = flags.all === true ? known.filter((name) => launch.members[name] !== undefined) : positional.slice(1)
  if (wanted.length === 0) return 'name the members to start, or pass --all'
  const unknown = wanted.filter((name) => !known.includes(name))
  if (unknown.length > 0) return `not in the configuration (the lead, the members, or the liaison): ${unknown.join(', ')}`
  // The login directories of the funding sources are kept for reading sessions and transcripts; a start is when a member may land on a new one.
  const dirsProblem = flags['dry-run'] === true || watchdogDeps?.fundingDirsPath === undefined ? null : refreshFundingDirs(ports, watchdogDeps.fundingDirsPath, watchdogDeps.now())
  const lines = wanted.map((name) => (report.rows.find((row) => row.name === name)?.isRunning === true ? `${name}: already runs, left alone` : startOne(config, ports, name, launch.tmuxSession, flags, watchdogDeps)))
  return [...lines, ...(dirsProblem === null ? [] : [`the funding sources could not be read, so their login directories are not updated: ${dirsProblem}`])].join('\n')
}

/** Stops the members named. An idle one is asked to exit; a busy one, or one waiting at a prompt, is left alone unless `--force`, which closes its window. */
function stopCommand(config: Config, ports: Ports, positional: readonly string[], flags: Flags, report: MemberReport, deps: WatchdogDeps | undefined): string {
  const launch = config.launch
  if (launch === undefined) return 'there is no launch section in the configuration, so there is no tmux session to stop members in'
  const wanted = positional.slice(1)
  if (wanted.length === 0) return 'name the members to stop'
  const lines = wanted.map((name) => {
    const row = report.rows.find((one) => one.name === name)
    if (row === undefined) return `${name}: not in the configuration (the lead, the members, or the liaison)`
    if (!row.hasWindow) return `${name}: has no window in the tmux session ${launch.tmuxSession}${row.isRunning ? ' (it runs elsewhere, so it is not stopped from here)' : ''}`
    const isBusy = row.state === 'busy' || row.state === 'waiting'
    if (isBusy && flags.force !== true) return `${name}: is ${row.state === 'waiting' ? 'waiting at a prompt' : 'busy'}; not stopped (--force closes its window)`
    try {
      ports.members.stop(launch.tmuxSession, name, flags.force === true ? 'kill' : 'graceful')
      if (flags.force === true) return `${name}: window closed`
      return `${name}: ${deps === undefined ? 'asked to exit' : finishExit(ports, launch.tmuxSession, name, deps, specOf(config, name).product).text}`
    } catch (error) {
      return `${name}: could not stop: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`
    }
  })
  return lines.join('\n')
}

/** The report of what is configured against what runs: it asks the host, so it is made only for the commands that need it. */
function reportOf(config: Config, ports: Ports): MemberReport {
  const windows = config.launch === undefined ? null : ports.members.windows(config.launch.tmuxSession)
  return memberReport(config, windows, ports.sessions.signals())
}

/** `scrum member ...`. Returns the text to print. */
export function memberCommand(config: Config, ports: Ports, positional: readonly string[], flags: Flags = {}, watchdogDeps?: WatchdogDeps): string {
  switch (positional[0]) {
    case 'list':
    {
      const report = reportOf(config, ports)
      const sources = watchdogDeps?.memberSourcesPath === undefined ? [] : readMemberSources(watchdogDeps.memberSourcesPath)
      const session = config.launch?.tmuxSession
      const waiting = waitingQuestions(report, (name) => (session === undefined ? null : ports.members.screen(session, name)))
      return formatReport(report, sources, runningVersions(report, watchdogDeps?.signals() ?? ports.sessions.signals(), ports.sessions), waiting)
    }
    case 'stop':
      return stopCommand(config, ports, positional, flags, reportOf(config, ports), watchdogDeps)
    case 'adopt':
      return adoptCommand(config, ports, positional, flags, watchdogDeps)
    case 'move':
      return moveCommand(config, ports, positional, flags, watchdogDeps)
    case 'continue':
      return continueCommand(config, ports, flags, watchdogDeps)
    case 'start':
      return startCommand(config, ports, positional, flags, reportOf(config, ports), watchdogDeps)
    default:
      return MEMBER_USAGE
  }
}

/** `scrum member continue [--dry-run]`: tells each Codex member that has been idle too long to go on, as `scrum refresh` does (see `continueIdle`). */
function continueCommand(config: Config, ports: Ports, flags: Flags, deps: WatchdogDeps | undefined): string {
  if (deps === undefined) return 'telling a member to go on needs the clock and the state directory, which only the command line has'
  const lines = continueIdle(config, ports, deps, flags['dry-run'] === true)
  return lines.length === 0 ? 'no Codex member needs to be told to go on' : lines.join('\n')
}
