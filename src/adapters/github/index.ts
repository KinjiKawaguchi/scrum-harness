import type { Config } from '../../config.ts'
import type { Ports } from '../../ports/index.ts'
import { bashActionReader } from './action-reader.ts'
import { githubBoardWriter, realExec } from './board-writer.ts'
import { githubCodeHost } from './code-host.ts'
import { sharedDir } from '../../board/shared.ts'
import { ghFor } from './gh.ts'
import { limitGuard } from './limit-guard.ts'
import { githubIssueThread } from './issues.ts'
import { projectBoardSource } from './project-board.ts'

/** Handles the GitHub Project board, issues, and PRs with gh and the configured scripts. */
export function githubPorts(config: Config): Pick<Ports, 'board' | 'writer' | 'actions' | 'issues' | 'code'> {
  const { run, within } = ghFor(config.host, (raw) => limitGuard({ directory: sharedDir(), team: config.team?.value ?? '', raw }))
  return {
    board: projectBoardSource(run, config),
    writer: githubBoardWriter(config, realExec(config), run),
    actions: bashActionReader(config),
    issues: githubIssueThread(run),
    code: githubCodeHost(run, config, within),
  }
}
