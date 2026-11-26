import type { Config } from '../config.ts'
import type { LaunchPlan, Ports } from '../ports/index.ts'
import type { MemberSpec } from './config.ts'
import { stateDir } from '../config.ts'
import { formatReport, memberReport, type MemberReport } from './list.ts'
import { planMember, specOf } from './plan.ts'
import type { Flags } from '../cli-commands.ts'
import { describePick, forgetMemberSource, pickFor, readMemberSources, recordMemberSource, type MemberSource } from './funding.ts'
import { clearStartFailure, recordStartFailure } from './start-failures.ts'
import { CODEX_TRUST_QUESTION, screenSummary, showsEnd, waitForLife, waitUntil, watchdogOf, type WaitDeps } from './watchdog.ts'

export const MEMBER_USAGE = `scrum member: the members of this team and where they run
  scrum member list                                  Each member in the configuration, whether it runs, and what runs but is not listed (or is listed and does not run)
  scrum member stop <name...> [--force]              Ask an idle member to exit. A busy member, or one at a permission prompt, only with --force, which closes its window
  scrum member start <name...> | --all [--dry-run] [--no-wait]   Start members in the tmux session of the launch section, from their settings; one that already runs is left alone. --dry-run prints what would run. A member with a startup watchdog (a Codex member by default) is waited for, closed, and started again if it shows no sign of life; --no-wait skips that`

const shellWord = (word: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)

/** What would run, as text. The brief is shown as a placeholder: it can be long, and it is not for the screen. */
function describePlan(name: string, dir: string, env: Readonly<Record<string, string>>, argv: readonly string[], brief: string): string {
  const shown = argv.map((word) => (brief !== '' && word === brief ? `<brief: ${brief.length} characters>` : shellWord(word)))
  const vars = Object.entries(env).map(([key, value]) => `${key}=${key === 'PATH' ? '<this process\'s PATH>' : shellWord(value)}`)
  return `${name}: in ${dir}\n  env ${vars.join(' ')} ${shown.join(' ')}`
}

/** What the watchdog needs: where the failures are kept, and the clock, the sleep, and the signs of life. */
export type WatchdogDeps = WaitDeps & { readonly startFailuresPath: string; /** Where the account each member started on is kept (for `member list`) */ readonly memberSourcesPath?: string }

/**
 * Starts a member, and waits for its sign of life when it has a startup watchdog: a member that shows none in time has its window closed and is
 * started again, up to its retries, and then recorded as a finding. Returns the line to print.
 */
function startWatched(ports: Ports, session: string, plan: LaunchPlan, spec: MemberSpec, watchdog: NonNullable<ReturnType<typeof watchdogOf>>, deps: WatchdogDeps): string {
  const tries = watchdog.retries + 1
  let lastScreen: string | null = null
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const since = deps.now()
    ports.members.start(session, plan)
    // Codex's one-time question about a directory is answered once, and only for a member that is set to have it answered.
    let answered = false
    const answerTrust = (): void => {
      if (answered || spec.trustDirectory !== true || spec.product !== 'codex' || !CODEX_TRUST_QUESTION.test(ports.members.screen(session, plan.name) ?? '')) return
      answered = true
      ports.members.press(session, plan.name, 'Enter')
    }
    if (waitForLife(plan.name, since, watchdog.seconds, deps, answerTrust)) {
      clearStartFailure(deps.startFailuresPath, plan.name)
      return `${plan.name}: started in ${plan.dir}${attempt > 1 ? ` (try ${attempt})` : ''}, shows a sign of life`
    }
    lastScreen = screenSummary(ports.members.screen(session, plan.name))
    try {
      ports.members.stop(session, plan.name, 'kill')
    } catch {
      // A window that is already gone needs no closing.
    }
  }
  recordStartFailure(deps.startFailuresPath, { name: plan.name, at: deps.now().toISOString(), tries, ...(lastScreen === null ? {} : { screen: lastScreen }) })
  const seen = lastScreen === null ? '' : ` Its window showed: ${lastScreen}.`
  return `${plan.name}: no sign of life after ${tries} start${tries === 1 ? '' : 's'} of ${watchdog.seconds} seconds; its window is closed and it is reported as a finding (M-START-FAILED).${seen}`
}

/** Starts one member that is not running: asks the node which account it runs under, plans the launch, and starts it (watched, where there is a watchdog). */
function startOne(config: Config, ports: Ports, name: string, session: string, flags: Flags, watchdogDeps: WatchdogDeps | undefined): string {
  const outcome = pickFor(ports, specOf(config, name))
  const sourcesPath = watchdogDeps?.memberSourcesPath
  if (outcome.kind === 'none' || outcome.kind === 'unguarded') {
    if (flags['dry-run'] !== true) noteSource(sourcesPath, watchdogDeps, name, { source: '', state: 'refused', reason: outcome.reason })
    return `${name}: not started: ${outcome.reason}`
  }
  const planned = planMember(config, name, stateDir(), process.env.PATH, ports.launchers, outcome.kind === 'picked' ? outcome.pick.env : {})
  if ('problem' in planned) return `${name}: ${planned.problem}`
  const { plan, brief } = planned
  const account = outcome.kind === 'picked' ? `\n${name}: ${describePick(outcome.pick)}` : outcome.kind === 'failed' ? `\n${name}: the account could not be picked (${outcome.reason}); it starts on its own settings` : ''
  if (flags['dry-run'] === true) return describePlan(plan.name, plan.dir, plan.env, plan.argv, brief) + account
  try {
    if (outcome.kind === 'picked') noteSource(sourcesPath, watchdogDeps, name, { source: outcome.pick.source ?? '', state: outcome.pick.state })
    else if (sourcesPath !== undefined) forgetMemberSource(sourcesPath, name)
    const watchdog = watchdogOf(planned.spec)
    if (watchdog !== null && watchdogDeps !== undefined && flags['no-wait'] !== true) return startWatched(ports, session, plan, planned.spec, watchdog, watchdogDeps) + account
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
  const lines = wanted.map((name) => (report.rows.find((row) => row.name === name)?.isRunning === true ? `${name}: already runs, left alone` : startOne(config, ports, name, launch.tmuxSession, flags, watchdogDeps)))
  return lines.join('\n')
}

/** Stops the members named. An idle one is asked to exit; a busy one, or one waiting at a prompt, is left alone unless `--force`, which closes its window. */
/** How long a member that was asked to exit has to end its session. */
const EXIT_SECONDS = 15

/**
 * After a member was asked to exit: waits for its session to end (its window going away, or its hook recording the end), and closes a window that is
 * left over (Codex shows its list of sessions after one ends). A member that does not end in time is left running.
 */
function finishExit(ports: Ports, session: string, name: string, deps: WatchdogDeps): string {
  const since = deps.now()
  const isGone = (): boolean => !(ports.members.windows(session) ?? []).includes(name)
  const ended = waitUntil(() => isGone() || showsEnd(deps.signals(), name, since), EXIT_SECONDS, deps)
  if (!ended) return `asked to exit, and still runs after ${EXIT_SECONDS} seconds (--force closes its window)`
  if (isGone()) return 'exited'
  try {
    ports.members.stop(session, name, 'kill')
  } catch {
    // A window that is already gone needs no closing.
  }
  return 'exited; the window Codex left open is closed'
}

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
      return `${name}: ${deps === undefined ? 'asked to exit' : finishExit(ports, launch.tmuxSession, name, deps)}`
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
      return formatReport(reportOf(config, ports), watchdogDeps?.memberSourcesPath === undefined ? [] : readMemberSources(watchdogDeps.memberSourcesPath))
    case 'stop':
      return stopCommand(config, ports, positional, flags, reportOf(config, ports), watchdogDeps)
    case 'start':
      return startCommand(config, ports, positional, flags, reportOf(config, ports), watchdogDeps)
    default:
      return MEMBER_USAGE
  }
}
