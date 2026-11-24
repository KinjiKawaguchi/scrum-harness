import { SCRUM_CLI } from '../cli-path.ts'
import type { Config } from '../config.ts'
import { makeFinding, type Finding } from '../findings/types.ts'
import { describeAnswer, isOpen } from './model.ts'
import { OWNER, type OwnerRequest } from './types.ts'

/** Who answered: the person's id when it was recorded, otherwise the owner. */
function answererOf(request: OwnerRequest, config: Config): string {
  const by = request.messages.findLast((one) => one.from === OWNER)?.by
  return by === undefined || by === OWNER ? config.ownerLabel : by
}

/**
 * R-ANSWERED: a request the owner answered and the team has not closed. Medium severity, so the watch process wakes the lead.
 * It goes away when the lead acts on the answer and closes the request with `scrum request close`.
 */
export function lintRequests(requests: readonly OwnerRequest[], config: Config): readonly Finding[] {
  return requests
    .filter((request) => isOpen(request) && request.waiting === 'team')
    .map((request) =>
      makeFinding({
        rule: 'R-ANSWERED',
        subject: request.id,
        severity: 'medium',
        message: `${answererOf(request, config)} answered the request "${request.title}": ${describeAnswer(request).slice(0, 600)}${request.issue === undefined ? '' : ` (${request.issue})`}`,
        fix: `Act on the answer, then close it with ${SCRUM_CLI} request close ${request.id} --note "<what was done>". To ask a follow-up: ${SCRUM_CLI} request reply ${request.id} --from <name> --text "<question>"`,
      }),
    )
}
