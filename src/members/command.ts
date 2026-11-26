import type { Config } from '../config.ts'
import type { Ports } from '../ports/index.ts'
import { formatReport, memberReport } from './list.ts'

export const MEMBER_USAGE = `scrum member: the members of this team and where they run
  scrum member list    Each member in the configuration, whether it runs, and what runs but is not listed (or is listed and does not run)`

/** `scrum member ...`. Returns the text to print. */
export function memberCommand(config: Config, ports: Ports, positional: readonly string[]): string {
  if (positional[0] !== 'list') return MEMBER_USAGE
  const windows = config.launch === undefined ? null : ports.members.windows(config.launch.tmuxSession)
  return formatReport(memberReport(config, windows, ports.sessions.signals()))
}
