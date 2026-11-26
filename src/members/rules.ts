import { makeFinding, type Finding } from '../findings/types.ts'
import { SCRUM_CLI } from '../cli-path.ts'
import type { MemberState } from '../team/types.ts'
import type { StartFailure } from './start-failures.ts'

/**
 * M-START-FAILED: a member was started, and again, and showed no sign of life. It goes away when the member shows one (it has a live session),
 * or when a start of it works. Medium, so the TechLead hears of it.
 */
export function lintStartFailures(failures: readonly StartFailure[], members: readonly MemberState[]): readonly Finding[] {
  const isLive = (name: string): boolean => members.some((member) => member.name === name && member.state !== 'unknown')
  return failures
    .filter((failure) => !isLive(failure.name))
    .map((failure) =>
      makeFinding({
        rule: 'M-START-FAILED',
        subject: failure.name,
        severity: 'medium',
        message: `${failure.name} was started ${failure.tries} time${failure.tries === 1 ? '' : 's'} and showed no sign of life (since ${failure.at})`,
        fix: `Look at its window (tmux), then start it again with ${SCRUM_CLI} member start ${failure.name}`,
      }),
    )
}
