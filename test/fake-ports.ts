import { githubBoardWriter, type Exec } from '../src/adapters/github/board-writer.ts'
import type { GhRun } from '../src/adapters/github/gh.ts'
import type { BoardItem, Snapshot } from '../src/board/types.ts'
import type { Config } from '../src/config.ts'
import type { Ports } from '../src/ports/index.ts'
import type { SessionSignal } from '../src/team/types.ts'

const unused = (name: string) => () => {
  throw new Error(`the fake port's ${name} is not used in this test`)
}

/**
 * A port that stays inside the process. It has no session, notifications and writes do nothing, and anything read from outside throws when called.
 * Only the parts a test uses are swapped out through overrides.
 */
export function fakePorts(overrides: Partial<Ports> = {}): Ports {
  return {
    board: { fetchSnapshot: unused('board.fetchSnapshot') as (now: Date) => Snapshot, statusEvents: () => new Map() },
    writer: {
      canAssign: true,
      assign: () => undefined,
      setStatus: () => undefined,
      canSetReason: true,
      setReason: () => undefined,
      addToBoard: () => undefined,
      setTeam: () => undefined,
      writeOverrun: () => [],
    },
    actions: { actionsOf: () => [], shellPatterns: () => ({ post: '', pre: '' }) },
    issues: { comments: unused('issues.comments'), openIssues: unused('issues.openIssues'), read: unused('issues.read'), writeBody: unused('issues.writeBody'), addComment: unused('issues.addComment') },
    code: { openPullRequests: unused('code.openPullRequests'), referencedIssues: () => null, prepareBranch: () => null, activity: () => null },
    members: { windows: () => null, start: unused('members.start') as () => never, stop: unused('members.stop') as () => never, screen: () => null, say: () => undefined, press: unused('members.press') as () => never },
    funding: null,
    fundingSources: null,
    budget: null,
    hasHooksIn: () => true,
    hasTranscriptIn: () => true,
    launchers: { 'claude-code': () => ['claude'], codex: () => ['codex'] },
    sessions: { find: () => ({ name: null, pid: null }), signals: (): readonly SessionSignal[] => [] },
    transcripts: { files: () => [], names: () => new Map(), scan: unused('transcripts.scan') as () => never },
    notify: () => undefined,
    ...overrides,
  }
}

/**
 * A port for tests that hand work to an idle member. The assignee and Status are written through the GitHub adapter (the configured script), and running the script goes to exec.
 * The work marker goes through probe (nothing is read if absent), and no branch is prepared.
 */
export function dispatchPorts(config: Config, exec: Exec, probe: (item: BoardItem) => string | null = () => null): Ports {
  const base = fakePorts()
  return { ...base, writer: githubBoardWriter(config, exec, unused('gh') as GhRun), code: { ...base.code, activity: probe } }
}
