/** The tool a session of a member runs, as the node's funding sources name it. */
export type FundingTool = 'claude' | 'codex'

/**
 * The node's answer to which account a new session should run under. `ok`: a source under its threshold. `unknown`: usage cannot be read, so the first
 * source. `overThreshold`: every source is past its threshold, and this is the one with the most room (the team goes on). `none`: every source is at its
 * real limit; there is no `env`.
 */
export type FundingPick = {
  readonly state: 'ok' | 'unknown' | 'overThreshold' | 'none'
  readonly source?: string
  /** What to set in the session's environment: `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, paths only, empty for the default login */
  readonly env: Readonly<Record<string, string>>
  readonly reason?: string
}

/** Asks the node which account a session of the tool should run under. Throws, with the reason, when it cannot be asked or does not answer. */
export type FundingPicker = (tool: FundingTool) => FundingPick
