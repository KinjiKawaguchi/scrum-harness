/** Token counts of one model response, as the transcript reports them. */
export type Tokens = {
  readonly input: number
  /** Written to the 5-minute prompt cache */
  readonly cacheWrite5m: number
  /** Written to the 1-hour prompt cache */
  readonly cacheWrite1h: number
  readonly cacheRead: number
  readonly output: number
}

/** The tokens of one billed model response (one request). */
export type UsageRow = {
  readonly requestId: string
  /** Epoch milliseconds */
  readonly at: number
  readonly model: string
  /** Fast mode costs more per token */
  readonly isFast: boolean
  readonly tokens: Tokens
}

/** One transcript of a session, or of a subagent the session started. `path` is how the source finds it again. */
export type TranscriptFile = {
  readonly path: string
  readonly sessionId: string
  /** The group of transcripts that belong together (the project folder). Lets the core skip groups that hold no team session. */
  readonly project: string
  readonly isSubagent: boolean
  readonly size: number
}

/**
 * One message an agent sent to another (a SendMessage call): who it went to, when, and the short label the sender gave it. The body is never read:
 * nothing but these fields leaves the transcript.
 */
export type SentMessage = {
  /** The id of the tool call, unique in the team */
  readonly toolUseId: string
  /** Epoch milliseconds */
  readonly at: number
  readonly to: string
  /** The sender's own short label, cut at 120 characters; empty when it gave none */
  readonly summary: string
}

export type TranscriptScan = {
  /** One row per request: the lines of a response that repeat the same usage are already merged */
  readonly rows: readonly UsageRow[]
  /** The messages the session sent, in the order they appear (never their bodies) */
  readonly messages: readonly SentMessage[]
  /** Names the session recorded about itself (a custom title or an agent name) */
  readonly titles: readonly string[]
  /** The position after the last complete line read. The next scan starts here. */
  readonly endOffset: number
}

/**
 * Where the agents' transcripts are read from. A transcript only grows, so a scan starts at the position the previous one ended at.
 */
export type TranscriptSource = {
  /** Every transcript the source can see, with its current size. Unreadable ones are dropped. */
  readonly files: () => readonly TranscriptFile[]
  /** Session id → the name the agent product recorded for it (the name shown for that session) */
  readonly names: () => ReadonlyMap<string, string>
  /** Reads `file` from `from`. Rows whose request id is in `skipRequestIds` are left out (the response the previous scan ended in). */
  readonly scan: (file: TranscriptFile, from: number, skipRequestIds: ReadonlySet<string>) => TranscriptScan
}
