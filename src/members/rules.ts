import { makeFinding, type Finding } from '../findings/types.ts'
import { SCRUM_CLI } from '../cli-path.ts'
import type { MemberState } from '../team/types.ts'
import type { MemberSource } from './funding.ts'
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
        message: `${failure.name} was started ${failure.tries} time${failure.tries === 1 ? '' : 's'} and showed no sign of life (since ${failure.at})${failure.screen === undefined ? '' : `. Its window showed: ${failure.screen}`}`,
        fix: `Look at its window (tmux), then start it again with ${SCRUM_CLI} member start ${failure.name}`,
      }),
    )
}

/**
 * M-SOURCE-REFUSED: the last start of a member was refused by the funding check (every source is at its limit, or the picked login has no harness hooks) and
 * it has no live session. Medium. It goes away when the member runs, or when a start of it is not refused.
 */
export function lintRefusedStarts(sources: readonly MemberSource[], members: readonly MemberState[]): readonly Finding[] {
  const isLive = (name: string): boolean => members.some((member) => member.name === name && member.state !== 'unknown')
  return sources
    .filter((source) => source.state === 'refused' && !isLive(source.name))
    .map((source) =>
      makeFinding({
        rule: 'M-SOURCE-REFUSED',
        subject: source.name,
        severity: 'medium',
        message: `${source.name} was not started (${source.at}): ${source.reason ?? 'no reason given'}`,
        fix: `Deal with the reason, then start it again with ${SCRUM_CLI} member start ${source.name}`,
      }),
    )
}
