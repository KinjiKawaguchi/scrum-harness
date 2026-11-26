import type { LaunchPlan, MemberHost } from '../../ports/index.ts'
import { realRun, runOrThrow, type Run } from '../run.ts'

/** Waits without a loop of work: used between typing a command and pressing Enter. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/** How long a typed command waits before Enter. Codex treats Enter that arrives with the text as part of it and does not run the command. */
const TYPE_THEN_ENTER_MS = 1000

/** The windows of a tmux session, and starting a member in one. */
export function tmuxHost(run: Run = realRun, sleep: (milliseconds: number) => void = sleepSync): MemberHost {
  const hasSession = (session: string): boolean => run('tmux', ['has-session', '-t', `=${session}`]).status === 0
  /** The window is named by its id: a name can match more than one window, and an id is exact. Null when the session or the window is not there. */
  const windowId = (session: string, name: string): string | null => {
    const result = run('tmux', ['list-windows', '-t', `=${session}`, '-F', '#{window_id} #{window_name}'])
    if (result.status !== 0) return null
    return result.stdout.split('\n').map((line) => line.trim().split(' ')).find(([, ...words]) => words.join(' ') === name)?.[0] ?? null
  }
  return {
    windows: (session) => {
      const result = run('tmux', ['list-windows', '-t', `=${session}`, '-F', '#{window_name}'])
      return result.status === 0 ? result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '') : null
    },
    screen: (session, name) => {
      const id = windowId(session, name)
      if (id === null) return null
      const result = run('tmux', ['capture-pane', '-p', '-t', id])
      return result.status === 0 ? result.stdout : null
    },
    press: (session, name, key) => {
      const id = windowId(session, name)
      if (id === null) throw new Error(`there is no window named ${name} in the tmux session ${session}`)
      runOrThrow(run, 'tmux', ['send-keys', '-t', id, key])
    },
    stop: (session, name, how) => {
      const id = windowId(session, name)
      if (id === null) throw new Error(`there is no window named ${name} in the tmux session ${session}`)
      if (how === 'kill') runOrThrow(run, 'tmux', ['kill-window', '-t', id])
      else {
        // Typed as text, then Enter a moment later, as a person does: Enter sent with the text was not taken as a command by Codex.
        runOrThrow(run, 'tmux', ['send-keys', '-t', id, '-l', '/exit'])
        sleep(TYPE_THEN_ENTER_MS)
        runOrThrow(run, 'tmux', ['send-keys', '-t', id, 'Enter'])
      }
    },
    start: (session, plan: LaunchPlan) => {
      if (!hasSession(session)) runOrThrow(run, 'tmux', ['new-session', '-d', '-s', session, '-n', 'home', '-c', plan.dir])
      const env = Object.entries(plan.env).map(([key, value]) => `${key}=${value}`)
      runOrThrow(run, 'tmux', ['new-window', '-d', '-t', `=${session}`, '-n', plan.name, '-c', plan.dir, 'env', ...env, ...plan.argv])
    },
  }
}
