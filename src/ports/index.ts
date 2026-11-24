import type { ActionReader, BoardSource, BoardWriter } from './board.ts'
import type { CodeHost } from './code-host.ts'
import type { IssueThread } from './issue-thread.ts'
import type { SessionDirectory } from './sessions.ts'

export type { ActionReader, BoardSource, BoardWriter } from './board.ts'
export type { CodeHost, LinkedBranch, LinkOutcome } from './code-host.ts'
export type { IssueBody, IssueComment, IssueThread } from './issue-thread.ts'
export type { SessionDirectory, SessionEntry } from './sessions.ts'

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
  readonly notify: Notifier
}
