import { githubBoardWriter, type Exec } from '../src/adapters/github/board-writer.ts'
import type { GhRun } from '../src/adapters/github/gh.ts'
import type { BoardItem, Snapshot } from '../src/board/types.ts'
import type { Config } from '../src/config.ts'
import type { Ports } from '../src/ports/index.ts'
import type { SessionSignal } from '../src/team/types.ts'

const unused = (name: string) => () => {
  throw new Error(`偽のポートの ${name} は、この試験では使わない`)
}

/**
 * 外に出ないポート。セッションは無く、通知と書き込みは何もせず、外から読むものは呼ばれたら投げる。
 * 試験で使う部分だけを overrides で差し替える。
 */
export function fakePorts(overrides: Partial<Ports> = {}): Ports {
  return {
    board: { fetchSnapshot: unused('board.fetchSnapshot') as (now: Date) => Snapshot, statusEvents: () => new Map() },
    writer: {
      canAssign: true,
      assign: () => undefined,
      setStatus: () => undefined,
      writeOverrun: () => [],
    },
    actions: { commandsOf: () => [], shellPatterns: () => ({ post: '', pre: '' }) },
    issues: { comments: unused('issues.comments'), openIssues: unused('issues.openIssues'), read: unused('issues.read'), writeBody: unused('issues.writeBody') },
    code: { openPullRequests: unused('code.openPullRequests'), referencedIssues: () => null, prepareBranch: () => null, activity: () => null },
    sessions: { find: () => ({ name: null, pid: null }), signals: (): readonly SessionSignal[] => [] },
    notify: () => undefined,
    ...overrides,
  }
}

/**
 * 空いた部下に渡す試験のポート。担当と Status は GitHub のアダプタ (設定のスクリプト) で書き、スクリプトの実行は exec が受ける。
 * 作業の印は probe (無ければ読まない)、ブランチは用意しない。
 */
export function dispatchPorts(config: Config, exec: Exec, probe: (item: BoardItem) => string | null = () => null): Ports {
  const base = fakePorts()
  return { ...base, writer: githubBoardWriter(config, exec, unused('gh') as GhRun), code: { ...base.code, activity: probe } }
}
