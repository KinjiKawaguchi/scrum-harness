/** Where a team's members run (a terminal multiplexer). */
export type MemberHost = {
  /** The names of the windows in the host's session, or null when that session does not exist (or the host is not installed). */
  readonly windows: (session: string) => readonly string[] | null
}
