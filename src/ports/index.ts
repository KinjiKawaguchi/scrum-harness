import type { ActionReader, BoardSource, BoardWriter } from './board.ts'
import type { CodeHost } from './code-host.ts'
import type { IssueThread } from './issue-thread.ts'
import type { BudgetReader } from './budget.ts'
import type { FundingLister, FundingPicker } from './funding.ts'
import type { ProductLauncher } from './launcher.ts'
import type { MemberHost } from './members.ts'
import type { Product } from '../members/config.ts'
import type { SessionDirectory } from './sessions.ts'
import type { TranscriptSource } from './usage.ts'

export type { ActionReader, BoardSource, BoardWriter, ToolCall } from './board.ts'
export type { CodeHost, LinkedBranch, LinkOutcome } from './code-host.ts'
export type { BodyThread, IssueBody, IssueComment, IssueThread } from './issue-thread.ts'
export type { ScheduledJob, ScheduleFile, Scheduler, ScheduleSetup } from './scheduler.ts'
export type { BudgetLine, BudgetReader, BudgetState, BudgetStatus } from './budget.ts'
export type { FundingLister, FundingPick, FundingPicker, FundingSource, FundingTool } from './funding.ts'
export type { LaunchPlan, MemberHost } from './members.ts'
export type { LaunchRequest, ProductLauncher } from './launcher.ts'
export type { SessionDirectory, SessionEntry } from './sessions.ts'
export type { SentMessage, Tokens, TranscriptFile, TranscriptScan, TranscriptSource, UsageRow } from './usage.ts'

/** Notifies the owner. Throws on failure. */
export type Notifier = (title: string, body: string) => void

/**
 * What the core asks of external systems. The core knows only this type and does not know which system implements it.
 * wiring.ts does the assembly, from the config.
 */
export type Ports = {
  readonly board: BoardSource
  readonly writer: BoardWriter
  readonly actions: ActionReader
  readonly issues: IssueThread
  readonly code: CodeHost
  readonly sessions: SessionDirectory
  readonly members: MemberHost
  /** Null when the team has no funding command */
  readonly funding: FundingPicker | null
  /** Null when the team has no funding command */
  readonly fundingSources: FundingLister | null
  /** Null when the team has no `launch.budget` */
  readonly budget: BudgetReader | null
  /** Whether the harness's hooks are in a Claude Code configuration directory (a member under another login runs unguarded and unwatched without them) */
  readonly hasHooksIn: (configDir: string) => boolean
  /** Whether the conversation of a session can be found under a Claude Code configuration directory (so that `--resume` works there) */
  readonly hasTranscriptIn: (configDir: string, sessionId: string) => boolean
  readonly launchers: Readonly<Record<Product, ProductLauncher>>
  readonly transcripts: TranscriptSource
  readonly notify: Notifier
}
