import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import { dispatchOf, type Config } from '../config.ts'
import type { LinkOutcome } from '../ports/index.ts'

/** 空いた部下に、止まっていない自分の作業中の issue を進めるよう促す、決まった文面。ボードは書き換えない。 */
export function nudgeMessage(item: BoardItem, member: string, config: Config): string {
  return [
    `scrum-harness: ${member} is idle. Continue ${label(item)} ${item.title}, which is In Progress.`,
    `- If you cannot proceed because you are waiting, set the blocked reason on the board and then tell ${config.techlead}`,
  ].join('\n')
}

/** 部下に送る、決まった文面。issue の番号と題、ブランチの土台、PR の宛先、マージする人、その日の決まり。 */
function branchLines(item: BoardItem, branch: LinkOutcome, config: Config): readonly string[] {
  const base = dispatchOf(config).baseBranch
  if (branch === null) return []
  if (branch === 'failed') {
    return [`- Could not prepare a branch linked to the issue (see errors.log). Create a branch yourself, and write ${label(item).replace(/^.*#/, '#')} in the PR body`]
  }
  return [
    branch.isNew
      ? `- A branch ${branch.name} linked to the issue was created from the tip of origin/${base}. Run git fetch origin, work on this branch, and open the PR from it (it shows in the Development field)`
      : `- The issue already had a linked branch, ${branch.name}. Its base may be old, so after git fetch origin check with git log ${branch.name}..origin/${base} that it is not behind origin/${base}, then work on this branch and open the PR from it (it shows in the Development field)`,
    `- Write ${label(item).replace(/^.*#/, '#')} in the PR body (so the PR links to the issue)`,
  ]
}

export function dispatchMessage(item: BoardItem, member: string, config: Config, branch: LinkOutcome = null): string {
  const dispatch = dispatchOf(config)
  return [
    `scrum-harness: handed the next work to ${member}.`,
    `${label(item)} ${item.title}`,
    `- Set the board Status to ${config.statuses.doing} and the assignee to ${member}`,
    `- Branch from origin/${dispatch.baseBranch}. The PR targets ${dispatch.baseBranch}. ${config.techlead} merges (after reading the diff)`,
    ...branchLines(item, branch, config),
    ...dispatch.notes.map((note) => `- ${note}`),
  ].join('\n')
}
