import { expandHome } from '../paths.ts'
import type { Ports } from '../ports/index.ts'
import type { SessionSignal } from '../team/types.ts'
import { baseName } from '../usage/attribution.ts'
import type { MemberSpec } from './config.ts'

/** What a member that is started again reads first: the conversation continues, and its brief is not sent again. */
export const RESTART_NOTE = 'You were started again. Nothing else changed: carry on with what you were doing.'

/** The latest session record of a member, live or ended; the one to continue. */
export function latestSession(signals: readonly SessionSignal[], name: string): SessionSignal | undefined {
  return signals.filter((signal) => baseName(signal.name) === name).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

/**
 * The session to continue for `scrum member start --resume`: the member's latest recorded one, which has to be visible under the login the member will
 * run on (`env` is what the picked account sets). A problem, with the way out, when there is none or it is not.
 */
export function resumeSession(ports: Ports, spec: MemberSpec, name: string, env: Readonly<Record<string, string>>): { readonly sessionId: string } | { readonly problem: string } {
  if (spec.product === 'codex') return { problem: '--resume continues a Claude Code conversation; a Codex member is not resumed' }
  const session = latestSession(ports.sessions.signals(), name)
  if (session === undefined) return { problem: `${name} has no recorded session to continue; start it without --resume` }
  const dir = expandHome(env.CLAUDE_CONFIG_DIR ?? spec.configDir ?? '~/.claude')
  if (!ports.hasTranscriptIn(dir, session.sessionId)) return { problem: `its last conversation is not visible under ${dir}; link that directory's projects to the login it ran on, so --resume finds it, or start it without --resume` }
  return { sessionId: session.sessionId }
}
