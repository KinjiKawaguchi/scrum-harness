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
    start: (session, plan: LaunchPlan) => {
      if (!hasSession(session)) runOrThrow(run, 'tmux', ['new-session', '-d', '-s', session, '-n', 'home', '-c', plan.dir])
      const env = Object.entries(plan.env).map(([key, value]) => `${key}=${value}`)
      runOrThrow(run, 'tmux', ['new-window', '-d', '-t', `=${session}`, '-n', plan.name, '-c', plan.dir, 'env', ...env, ...plan.argv])
    },
  }
}
