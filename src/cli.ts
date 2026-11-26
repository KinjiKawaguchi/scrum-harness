import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRefreshDue, refreshSnapshot } from './board/snapshot.ts'
import {
  ackCommand,
  checkpointCommand,
  pointsCommand,
  acksCommand,
  installCommand,
  settingsTargets,
  lintCommand,
  parseFlags,
  reportCommand,
  statuslineCommand,
  teamCommand,
  writeShellPatterns,
} from './cli-commands.ts'
import { alertsCommand } from './alerts/command.ts'
import { configPath, dispatchOf, loadConfig, stateDir, type Config } from './config.ts'
import { dispatchOnce, formatOnce } from './dispatch/once.ts'
import { handleHook } from './hooks/handlers.ts'
import { linkPullRequests, type LinkPlan } from './links/run.ts'
import { hookDeps, parseInput, readStdin, spawnRefresh, spawnUsageIndex } from './runtime.ts'
import { runUsageIndex } from './usage/run.ts'
import { initCommand } from './init/command.ts'
import { scheduleCommand } from './schedule/command.ts'
import { scheduleSetup } from './schedule/setup.ts'
import { SCRUM_CLI } from './cli-path.ts'
import { logError, paths, type Paths } from './store.ts'
import { resolveIdentity } from './team/identity.ts'
import type { Ports } from './ports/index.ts'
import { watchFor } from './watch-role.ts'
import { boardCommand } from './board/board-command.ts'
import { requestCommand } from './requests/command.ts'
import { buildPorts, buildScheduler } from './wiring.ts'
import { runRuntime } from './agency-runtime/handle.ts'

const DEFAULT_STATE_DIR = join(homedir(), '.claude', 'scrum')

const USAGE = `scrum: check the GitHub Project board and member activity
  scrum lint [--refresh] [--json]   all findings
  scrum team                        TechLead and member activity
  scrum refresh                     refresh the board copy
  scrum ack <rule> <subject> (--for 2h | --until <time>) --reason "<reason>"
                                    A T-IDLE acknowledgement lasts at most 1 hour; the reason is "Waiting for <owner>'s answer" or "slot HH:MM"
  scrum acks                        acknowledged exceptions
  scrum report [--since YYYY-MM-DD] summary for the sprint review
  scrum points                      points, budget, effort, and overrun of In Progress issues
  scrum link-prs [--dry-run]        list open PRs between the markers in the body of the issue each one points to (the watch runs it too when links.enabled; --dry-run only shows the plan)
  scrum alerts                      advance the stall detection (E-STALL, Q-EMPTY) once; the scheduler (scrum schedule) runs it every 5 minutes
  scrum dispatch --once [<name>...] for idle members, pick the next work once, write it to the board, and print the text to send (for members already idle right after enabling dispatch)
  scrum checkpoint                  record the last checkpoint not yet recorded (the watch also records it)
  scrum board <add|move>              Add an issue to the board, or hand an item to another team (when the board is shared). Run it with no arguments for the shape
  scrum request <add|list|show|reply|close>  Requests to the owner: a question or a proposal. Run it with no arguments for the shape. An answer reaches the lead as R-ANSWERED
  scrum usage-index                 read what the team's transcripts gained since the last run (scrum runtime starts it in the background for tokenUsage)
  scrum init --project-id <id> --status-field-id <id> --repos <owner/name,...> --owner-user <@login> [...]
                                    write a minimal team configuration and the state directory (scrum init with no flags shows the rest)
  scrum schedule <install|uninstall|status|print> [--name <team>]
                                    run the background loop under launchd (macOS) or a systemd user timer (Linux); print shows the files only
  scrum statusline                  short display for the statusline (the statusline JSON on stdin)
  scrum install | uninstall [--dir <config dir> | --all]   add or remove the hooks in ~/.claude/settings.json, in one Claude Code configuration directory, or in every configured one
  scrum hook <Event> | watch        called from Claude Code hooks`

function identityOf(p: Paths, input: Record<string, unknown>, now: Date, config: Config, ports: Ports) {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  return sessionId === '' ? null : resolveIdentity(p, sessionId, now, config, ports.sessions)
}

/** A hook does not stop the session even on failure. The error is only recorded, and it exits with 0. */
async function runHook(p: Paths, event: string): Promise<number> {
  const config = loadConfig()
  if (config === null) return 0
  try {
    const input = parseInput(await readStdin())
    const now = new Date()
    const ports = buildPorts(config)
    const result = handleHook(event, input, hookDeps(p, config, identityOf(p, input, now, config, ports), now, ports))
    if (result.stdout !== undefined) process.stdout.write(JSON.stringify(result.stdout))
  } catch (error) {
    logError(p, `hook ${event}`, error)
  }
  return 0
}

const WATCH_MAX_MS = 50 * 60_000
const WATCH_INTERVAL_MS = 30_000

/**
 * The TechLead waits for findings, and a member waits for the moment the next work is handed over only when dispatch is enabled.
 * The liaison waits for the notification text that stall detection decided, only when alerts is enabled.
 * To wake, it writes the text to stderr and exits with 2 (asyncRewake).
 */
async function runWatchCommand(p: Paths): Promise<number> {
  const config = loadConfig()
  if (config === null) return 0
  const input = parseInput(await readStdin())
  const ports = buildPorts(config)
  const identity = identityOf(p, input, new Date(), config, ports)
  if (identity === null) return 0
  const message = await watchFor(p, config, identity.name, { maxMs: WATCH_MAX_MS, intervalMs: WATCH_INTERVAL_MS }, ports)
  if (message === null) return 0
  process.stderr.write(message)
  return 2
}

/** agency-runtime/1: one JSON request on stdin, one JSON response on stdout, exit 0 for a result and 1 for an error. */
async function runRuntimeCommand(p: Paths, config: Config | null, ports: Ports | null): Promise<number> {
  const deps = config === null || ports === null ? null : { p, config, now: new Date(), ports, spawnRefresh, spawnUsageIndex }
  const output = runRuntime(await readStdin(), deps)
  process.stdout.write(output.stdout)
  return output.exitCode
}

/** `scrum schedule`: a failure of the system's scheduler is shown with its own message and exit code 1. */
function runSchedule(action: string, instance: string): number {
  try {
    const setup = scheduleSetup({
      home: homedir(),
      scrumDir: fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''),
      stateDir: stateDir(),
      defaultStateDir: DEFAULT_STATE_DIR,
      nodePath: process.execPath,
      shellPath: process.env.PATH ?? '',
      instance,
      requireGh: action === 'install' || action === 'print',
    })
    const result = scheduleCommand(action, buildScheduler(), setup)
    process.stdout.write(`${result.text}\n`)
    return result.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const p = paths()
  const [command = 'help', ...rest] = argv
  const { positional, flags } = parseFlags(rest)
  const print = (text: string) => {
    if (text !== '') process.stdout.write(`${text}\n`)
    return 0
  }
  const config = loadConfig()
  const ports = config === null ? null : buildPorts(config)
  if (command === 'runtime') return runRuntimeCommand(p, config, ports)
  if (config !== null && ports !== null) writeShellPatterns(p, config, ports.actions)
  const needConfig = (run: (config: Config, ports: Ports) => string) =>
    print(config === null || ports === null ? `There is no configuration, or a value is missing: ${configPath()} (copy config.example.json and edit it)` : run(config, ports))
  switch (command) {
    case 'hook':
      return runHook(p, positional[0] ?? '')
    case 'watch':
      return runWatchCommand(p)
    case 'board':
      return needConfig((cfg, prt) => boardCommand(p, cfg, prt, positional, flags))
    case 'request':
      return print(requestCommand(p, positional, flags, positional[0] === 'add' ? await readStdin() : '', new Date()))
    case 'init': {
      const dir = typeof flags['state-dir'] === 'string' ? flags['state-dir'] : stateDir()
      const result = initCommand(dir, dir === DEFAULT_STATE_DIR, SCRUM_CLI, flags)
      process.stdout.write(`${result.text}\n`)
      return result.ok ? 0 : 1
    }
    case 'schedule':
      return runSchedule(positional[0] ?? '', typeof flags.name === 'string' ? flags.name : '')
    case 'refresh': {
      return needConfig((c, ports) => {
        const snapshot = refreshSnapshot(p, c, new Date(), ports.board)
        return snapshot === null ? `Could not refresh (another process is refreshing, or an error; see ${p.errors})` : `Refreshed ${snapshot.items.length} items`
      })
    }
    case 'lint':
      return needConfig((c, ports) => lintCommand(p, c, flags, ports))
    case 'team':
      return needConfig((c, ports) => teamCommand(p, c, ports.sessions))
    case 'ack':
      return print(ackCommand(p, positional, flags, config, new Date(), ports?.issues ?? null))
    case 'acks':
      return print(acksCommand(p))
    case 'report':
      return print(reportCommand(p, flags))
    case 'link-prs':
      return needConfig((c, ports) => {
        const result = linkPullRequests(p, c, new Date(), ports, { dryRun: flags['dry-run'] === true })
        const reasonOf = (plan: LinkPlan) => result.skipped.find((one) => one.plan === plan)?.reason
        const mark = (plan: LinkPlan) => (result.applied.includes(plan) ? ' (rewritten)' : reasonOf(plan) === undefined ? '' : ` (skipped: ${reasonOf(plan)})`)
        const lines = result.planned.map((plan) => `${plan.repo}#${plan.issue}: ${plan.entries.map((entry) => `#${entry.number}`).join(' ') || '(remove the pair of markers)'}${mark(plan)}`)
        const broken = result.broken.map((one) => `${one.repo}#${one.issue}: the markers are broken (only one of them, two or more pairs, or in reverse order). Not rewritten`)
        return [...lines, ...broken, `${result.planned.length} planned, ${result.applied.length} rewritten, ${result.skipped.length} skipped, ${result.broken.length} with broken markers`].join('\n')
      })
    case 'alerts':
      return needConfig((c, ports) => alertsCommand(p, c, new Date(), ports))
    case 'dispatch':
      return needConfig((c, ports) => {
        if (flags.once !== true) return 'Usage: scrum dispatch --once [<name>...]'
        const now = new Date()
        if (isRefreshDue(p, c, now)) refreshSnapshot(p, c, now, ports.board)
        return formatOnce(dispatchOnce(p, c, now, ports, positional))
      })
    case 'usage-index':
      return needConfig((c, ports) => {
        const done = runUsageIndex(p, c, ports.transcripts, new Date())
        return done === null ? 'Another process is reading the transcripts' : `Read ${done.files} transcripts; the index has ${done.rows} rows`
      })
    case 'checkpoint':
      return needConfig((c, ports) => checkpointCommand(p, c, ports))
    case 'points':
      return needConfig((c) => pointsCommand(p, c))
    case 'statusline': {
      const input = parseInput(await readStdin())
      return config === null || ports === null ? 0 : print(statuslineCommand(p, config, input, ports.sessions))
    }
    case 'install':
    case 'uninstall': {
      const targets = settingsTargets(flags, config)
      return print(typeof targets === 'string' ? targets : installCommand(p, command === 'install', targets))
    }
    default:
      return print(USAGE)
  }
}

process.exitCode = await main(process.argv.slice(2))
