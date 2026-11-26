import type { MemberHost } from '../../ports/index.ts'
import { realRun, type Run } from '../run.ts'

/** Lists the windows of a tmux session. A session that does not exist, or no tmux, is null. */
export function tmuxHost(run: Run = realRun): MemberHost {
  return {
    windows: (session) => {
      const result = run('tmux', ['list-windows', '-t', `=${session}`, '-F', '#{window_name}'])
      return result.status === 0 ? result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '') : null
    },
  }
}
