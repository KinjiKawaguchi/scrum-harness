import type { Config } from '../../config.ts'
import type { Ports } from '../../ports/index.ts'
import { bashActionReader } from './action-reader.ts'
import { githubBoardWriter, realExec } from './board-writer.ts'
import { githubCodeHost } from './code-host.ts'
import { gh } from './gh.ts'
import { githubIssueThread } from './issues.ts'
import { projectBoardSource } from './project-board.ts'

/** Handles the GitHub Project board, issues, and PRs with gh and the configured scripts. */
export function githubPorts(config: Config): Pick<Ports, 'board' | 'writer' | 'actions' | 'issues' | 'code'> {
  return {
    board: projectBoardSource(gh, config),
    writer: githubBoardWriter(config, realExec(config), gh),
    actions: bashActionReader(config),
    issues: githubIssueThread(gh),
    code: githubCodeHost(gh, config),
  }
}
