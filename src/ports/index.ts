import type { ActionReader, BoardSource, BoardWriter } from './board.ts'
import type { CodeHost } from './code-host.ts'
import type { IssueThread } from './issue-thread.ts'
import type { SessionDirectory } from './sessions.ts'

export type { ActionReader, BoardSource, BoardWriter } from './board.ts'
export type { CodeHost, LinkedBranch, LinkOutcome } from './code-host.ts'
export type { IssueBody, IssueComment, IssueThread } from './issue-thread.ts'
export type { SessionDirectory, SessionEntry } from './sessions.ts'

/** オーナーに知らせる。失敗したら投げる。 */
export type Notifier = (title: string, body: string) => void

/**
 * 中心が外のシステムに求めるもの。中心はこの型だけを知り、どのシステムで実装したかを知らない。
 * 組み立ては wiring.ts が、設定から行う。
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
