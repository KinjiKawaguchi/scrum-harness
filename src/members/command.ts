import type { Config } from '../config.ts'
import type { Ports } from '../ports/index.ts'
import { stateDir } from '../config.ts'
import { formatReport, memberReport, type MemberReport } from './list.ts'
import { planMember } from './plan.ts'
import type { Flags } from '../cli-commands.ts'

export const MEMBER_USAGE = `scrum member: the members of this team and where they run
  scrum member list                                  Each member in the configuration, whether it runs, and what runs but is not listed (or is listed and does not run)
  scrum member stop <name...> [--force]              Ask an idle member to exit. A busy member, or one at a permission prompt, only with --force, which closes its window
  scrum member start <name...> | --all [--dry-run]   Start members in the tmux session of the launch section, from their settings; one that already runs is left alone. --dry-run prints what would run`

const shellWord = (word: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)

/** What would run, as text. The brief is shown as a placeholder: it can be long, and it is not for the screen. */
function describePlan(name: string, dir: string, env: Readonly<Record<string, string>>, argv: readonly string[], brief: string): string {
  const shown = argv.map((word) => (brief !== '' && word === brief ? `<brief: ${brief.length} characters>` : shellWord(word)))
  const vars = Object.entries(env).map(([key, value]) => `${key}=${key === 'PATH' ? '<this process\'s PATH>' : shellWord(value)}`)
  return `${name}: in ${dir}\n  env ${vars.join(' ')} ${shown.join(' ')}`
}

function startCommand(config: Config, ports: Ports, positional: readonly string[], flags: Flags, report: MemberReport): string {
  const launch = config.launch
  if (launch === undefined) return 'there is no launch section in the configuration, so there is no tmux session to start members in'
  const known = report.rows.map((row) => row.name)
  const wanted = flags.all === true ? known.filter((name) => launch.members[name] !== undefined) : positional.slice(1)
  if (wanted.length === 0) return 'name the members to start, or pass --all'
  const unknown = wanted.filter((name) => !known.includes(name))
  if (unknown.length > 0) return `not in the configuration (the lead, the members, or the liaison): ${unknown.join(', ')}`
  const lines = wanted.map((name) => {
    if (report.rows.find((row) => row.name === name)?.isRunning === true) return `${name}: already runs, left alone`
    const planned = planMember(config, name, stateDir(), process.env.PATH, ports.launchers)
    if ('problem' in planned) return `${name}: ${planned.problem}`
    const { plan, brief } = planned
    if (flags['dry-run'] === true) return describePlan(plan.name, plan.dir, plan.env, plan.argv, brief)
    try {
      ports.members.start(launch.tmuxSession, plan)
      return `${name}: started in ${plan.dir}`
    } catch (error) {
      return `${name}: could not start: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`
    }
  })
  return lines.join('\n')
}

/** Stops the members named. An idle one is asked to exit; a busy one, or one waiting at a prompt, is left alone unless `--force`, which closes its window. */
function stopCommand(config: Config, ports: Ports, positional: readonly string[], flags: Flags, report: MemberReport): string {
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
      return `${name}: ${flags.force === true ? 'window closed' : 'asked to exit'}`
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
export function memberCommand(config: Config, ports: Ports, positional: readonly string[], flags: Flags = {}): string {
  switch (positional[0]) {
    case 'list':
      return formatReport(reportOf(config, ports))
    case 'stop':
      return stopCommand(config, ports, positional, flags, reportOf(config, ports))
    case 'start':
      return startCommand(config, ports, positional, flags, reportOf(config, ports))
    default:
      return MEMBER_USAGE
  }
}
