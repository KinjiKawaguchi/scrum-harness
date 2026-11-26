import type { LaunchPlan, Ports } from '../ports/index.ts'
import type { MemberSpec, Product } from './config.ts'
import { clearStartFailure, recordStartFailure } from './start-failures.ts'
import { CODEX_TRUST_QUESTION, screenSummary, showsEnd, waitForLife, waitUntil, watchdogOf, type WaitDeps } from './watchdog.ts'

/** What a start came to: whether the member is up, and the line to print. */
export type StartResult = { readonly isStarted: boolean; readonly text: string }

/** What an exit request came to: whether the member's session ended, and the words for it. */
export type ExitResult = { readonly isExited: boolean; readonly text: string }

/** What the watchdog needs: where the failures are kept, and the clock, the sleep, and the signs of life. */
export type WatchdogDeps = WaitDeps & {
  readonly startFailuresPath: string
  /** Where the account each member started on is kept (for `member list`) */
  readonly memberSourcesPath?: string
  /** Where the login directories of the funding sources are kept; refreshed at each start */
  readonly fundingDirsPath?: string
  /** Where what the node last said of the weekly budget is kept (used when the node cannot be asked at a start) */
  readonly budgetPath?: string
  /** Where the time of the last automatic move is kept */
  readonly memberMovesPath?: string
}

/**
 * Starts a member, and waits for its sign of life when it has a startup watchdog: a member that shows none in time has its window closed and is
 * started again, up to its retries, and then recorded as a finding. Returns the line to print.
 */
export function startWatched(ports: Ports, session: string, plan: LaunchPlan, spec: MemberSpec, watchdog: NonNullable<ReturnType<typeof watchdogOf>>, deps: WatchdogDeps): StartResult {
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
      return { isStarted: true, text: `${plan.name}: started in ${plan.dir}${attempt > 1 ? ` (try ${attempt})` : ''}, shows a sign of life` }
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
  const text = `${plan.name}: no sign of life after ${tries} start${tries === 1 ? '' : 's'} of ${watchdog.seconds} seconds; its window is closed and it is reported as a finding (M-START-FAILED).${seen}`
  return { isStarted: false, text }
}

/** How long a member that was asked to exit has to end its session. */
const EXIT_SECONDS = 15

/**
 * After a member was asked to exit: waits for its session to end (its window going away, or its hook recording the end), and closes a window that is
 * left over (Codex shows its list of sessions after one ends). A member that does not end in time is left running.
 */
export function finishExit(ports: Ports, session: string, name: string, deps: WatchdogDeps, product: Product = 'claude-code'): ExitResult {
  const since = deps.now()
  const isGone = (): boolean => !(ports.members.windows(session) ?? []).includes(name)
  const ended = waitUntil(() => isGone() || showsEnd(deps.signals(), name, since), EXIT_SECONDS, deps)
  if (!ended) return { isExited: false, text: `asked to exit, and still runs after ${EXIT_SECONDS} seconds (--force closes its window)` }
  if (isGone()) return { isExited: true, text: 'exited' }
  try {
    ports.members.stop(session, name, 'kill')
  } catch {
    // A window that is already gone needs no closing.
  }
  return { isExited: true, text: product === 'codex' ? 'exited; the window Codex left open is closed' : 'exited; its window was still open and is closed' }
}
