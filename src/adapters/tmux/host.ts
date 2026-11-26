import type { LaunchPlan, MemberHost } from '../../ports/index.ts'
import { realRun, runOrThrow, type Run } from '../run.ts'

/** The windows of a tmux session, and starting a member in one. */
export function tmuxHost(run: Run = realRun): MemberHost {
  const hasSession = (session: string): boolean => run('tmux', ['has-session', '-t', `=${session}`]).status === 0
  return {
    windows: (session) => {
      const result = run('tmux', ['list-windows', '-t', `=${session}`, '-F', '#{window_name}'])
      return result.status === 0 ? result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '') : null
    },
    stop: (session, name, how) => {
      // The window is named by its id: a name can match more than one window, and an id is exact.
      const listing = runOrThrow(run, 'tmux', ['list-windows', '-t', `=${session}`, '-F', '#{window_id} #{window_name}'])
      const id = listing.split('\n').map((line) => line.trim().split(' ')).find(([, ...words]) => words.join(' ') === name)?.[0]
      if (id === undefined) throw new Error(`there is no window named ${name} in the tmux session ${session}`)
      if (how === 'kill') runOrThrow(run, 'tmux', ['kill-window', '-t', id])
      else runOrThrow(run, 'tmux', ['send-keys', '-t', id, '/exit', 'Enter'])
    },
    start: (session, plan: LaunchPlan) => {
      if (!hasSession(session)) runOrThrow(run, 'tmux', ['new-session', '-d', '-s', session, '-n', 'home', '-c', plan.dir])
      const env = Object.entries(plan.env).map(([key, value]) => `${key}=${value}`)
      runOrThrow(run, 'tmux', ['new-window', '-d', '-t', `=${session}`, '-n', plan.name, '-c', plan.dir, 'env', ...env, ...plan.argv])
    },
  }
}
