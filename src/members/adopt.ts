import type { Flags } from '../cli-commands.ts'
import type { Config } from '../config.ts'
import type { FundingSource, Ports } from '../ports/index.ts'
import { readMemberSources, recordMemberSource } from './funding.ts'
import type { WatchdogDeps } from './lifecycle.ts'
import { memberReport, type MemberRow } from './list.ts'
import { latestSession } from './resume.ts'

/** The source a running member is on when it was started some other way: the one the node lists without a login directory (the default login), or the one named. */
function sourceFor(sources: readonly FundingSource[], flag: string | true | undefined): { readonly source: string } | { readonly problem: string } {
  if (typeof flag === 'string') return sources.some((one) => one.source === flag && one.tool === 'claude') ? { source: flag } : { problem: `the node lists no Claude source named ${flag} (it lists: ${sources.filter((one) => one.tool === 'claude').map((one) => one.source).join(', ') || 'none'})` }
  const defaults = sources.filter((one) => one.tool === 'claude' && one.env.CLAUDE_CONFIG_DIR === undefined)
  return defaults.length === 1 && defaults[0] !== undefined ? { source: defaults[0].source } : { problem: 'the node does not list exactly one Claude source on the default login; say which with --source <name>' }
}

function adoptOne(ports: Ports, row: MemberRow | undefined, name: string, source: string, deps: WatchdogDeps): string {
  if (row === undefined) return `${name}: not in the configuration (the lead, the members, or the liaison)`
  if (!row.isRunning) return `${name}: does not run, so there is nothing to adopt; start it with \`scrum member start\``
  const session = latestSession(ports.sessions.signals(), name)
  if (session === undefined || !session.isAlive || session.state === 'ended') return `${name}: has no live session record to adopt`
  if (deps.memberSourcesPath === undefined) return `${name}: nowhere to keep the record`
  const known = readMemberSources(deps.memberSourcesPath).find((one) => one.name === name && one.state !== 'refused' && one.source !== '')
  if (known !== undefined) return `${name}: already recorded on ${known.source}; left alone`
  recordMemberSource(deps.memberSourcesPath, { name, source, state: 'ok', at: deps.now().toISOString(), sessionId: session.sessionId })
  return `${name}: adopted on ${source} (it keeps running; nothing was restarted)`
}

/**
 * `scrum member adopt <name>... | --all [--source <name>]`: records members that already run (they were started some other way) as being on the default login,
 * or on the source named, from their live session record. Nothing is restarted. `member list` and `member move` know them afterwards. The harness cannot tell
 * which login a session runs under, so the person says so with --source when it is not the default one.
 */
export function adoptCommand(config: Config, ports: Ports, positional: readonly string[], flags: Flags, deps: WatchdogDeps | undefined): string {
  const launch = config.launch
  if (launch === undefined || ports.fundingSources === null) return 'adopting a member needs a launch section and launch.funding in the configuration'
  if (deps === undefined) return 'adopting needs the clock and the state directory, which only the command line has'
  const report = memberReport(config, ports.members.windows(launch.tmuxSession), ports.sessions.signals())
  const recorded = new Set(deps.memberSourcesPath === undefined ? [] : readMemberSources(deps.memberSourcesPath).filter((one) => one.state !== 'refused' && one.source !== '').map((one) => one.name))
  const wanted = flags.all === true ? report.rows.filter((row) => row.isRunning && !recorded.has(row.name)).map((row) => row.name) : positional.slice(1)
  if (wanted.length === 0) return flags.all === true ? 'every running member is already recorded' : 'name the members to adopt, or pass --all'
  let sources: readonly FundingSource[]
  try {
    sources = ports.fundingSources()
  } catch (error) {
    return `the node cannot be asked, so nothing is adopted: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`
  }
  const source = sourceFor(sources, flags.source)
  if ('problem' in source) return source.problem
  return wanted.map((name) => adoptOne(ports, report.rows.find((row) => row.name === name), name, source.source, deps)).join('\n')
}
