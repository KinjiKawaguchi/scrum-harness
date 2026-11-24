import { label } from '../board/rules.ts'
import type { BoardItem } from '../board/types.ts'
import { dispatchOf, type Config } from '../config.ts'
import type { LinkOutcome } from './linked-branch.ts'

/** 空いた部下に、止まっていない自分の作業中の issue を進めるよう促す、決まった文面。ボードは書き換えない。 */
export function nudgeMessage(item: BoardItem, member: string, config: Config): string {
  return [
    `scrum-harness: ${member} が空いている。作業中の ${label(item)} ${item.title} を進める。`,
    `- 待ちで進められないときは、ボードの止まっている理由を付けてから、${config.techlead} に伝える`,
  ].join('\n')
}

/** 部下に送る、決まった文面。issue の番号と題、ブランチの土台、PR の宛先、マージする人、その日の決まり。 */
function branchLines(item: BoardItem, branch: LinkOutcome, config: Config): readonly string[] {
  const base = dispatchOf(config).baseBranch
  if (branch === null) return []
  if (branch === 'failed') {
    return [`- issue に紐づいたブランチは用意できなかった (記録は errors.log)。自分でブランチを切り、PR の本文に ${label(item).replace(/^.*#/, '#')} を書く`]
  }
  return [
    branch.isNew
      ? `- issue に紐づいたブランチ ${branch.name} を、origin/${base} の先頭から作ってある。git fetch origin してから、このブランチで作業し、PR はここから出す (Development の欄に出る)`
      : `- issue に紐づいたブランチ ${branch.name} は、すでにあったもの。土台が古いことがあるので、git fetch origin のあと、git log ${branch.name}..origin/${base} で origin/${base} に遅れていないかを見てから、このブランチで作業し、PR はここから出す (Development の欄に出る)`,
    `- PR の本文には ${label(item).replace(/^.*#/, '#')} を書く (PR から issue に飛べる)`,
  ]
}

export function dispatchMessage(item: BoardItem, member: string, config: Config, branch: LinkOutcome = null): string {
  const dispatch = dispatchOf(config)
  return [
    `scrum-harness: ${member} に次の仕事を渡した。`,
    `${label(item)} ${item.title}`,
    `- ボードの Status を ${config.statuses.doing}、担当を ${member} にした`,
    `- origin/${dispatch.baseBranch} から切る。PR は ${dispatch.baseBranch} 宛て。マージは ${config.techlead} (差分を読んでから)`,
    ...branchLines(item, branch, config),
    ...dispatch.notes.map((note) => `- ${note}`),
  ].join('\n')
}
