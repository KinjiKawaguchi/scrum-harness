/** Where a team's members run (a terminal multiplexer). */
export type MemberHost = {
  /** The names of the windows in the host's session, or null when that session does not exist (or the host is not installed). */
  readonly windows: (session: string) => readonly string[] | null
  /**
   * Stops the window named `name`: `graceful` asks the program in it to exit (as a person would, by typing `/exit`), `kill` closes the window.
   * Throws when the host refuses or has no such window.
   */
  readonly stop: (session: string, name: string, how: 'graceful' | 'kill') => void
  /** Starts a window named `plan.name` in the session (creating the session when it is not there). Throws when the host refuses. */
  readonly start: (session: string, plan: LaunchPlan) => void
}

/** A member ready to start: where, with what environment, and the command line. */
export type LaunchPlan = {
  readonly name: string
  readonly dir: string
  readonly env: Readonly<Record<string, string>>
  readonly argv: readonly string[]
}
