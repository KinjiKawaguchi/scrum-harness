import type { Config } from '../config.ts'
import { NOTICE_TITLE } from './text.ts'
import type { Notice } from './types.ts'

/**
 * Combines the notifications to the owner produced in one evaluation into a single one. The macOS notification becomes one, and the PushNotification to the liaison becomes one.
 * With one item it is left as is. With two or more, they are lined up as one line per item (with the reason it is stalled). The combined notification holds all the fingerprints of the combined items
 * (the marker for what was sent is attached to all of the combined items).
 */
export function mergeOwner(notices: readonly Notice[], config: Config): Notice | null {
  const [only, ...rest] = notices
  if (only === undefined) return null
  if (rest.length === 0) return only
  const members = notices.flatMap((notice) => notice.members ?? [notice.key])
  const lines = notices.map((notice) => notice.owner?.line ?? notice.key)
  const waiting = notices.flatMap((notice) => notice.owner?.waiting ?? [])
  const body = [`There are ${notices.length} stalls.`, ...lines.map((line) => `- ${line}`)]
  const addQuestion = waiting.length === 0 ? [] : [`  For the ones waiting for ${config.ownerLabel}'s answer, add one line with the pending question (subjects: ${waiting.join(', ')})`]
  return {
    key: `batch:${members.toSorted().join('+')}`,
    kind: 'owner',
    members,
    text: [`- ${notices.length} stalls: send ${config.ownerLabel} one PushNotification (no sound; do not change the text)`, ...body.map((line) => `  ${line}`), ...addQuestion].join('\n'),
    desktop: { title: NOTICE_TITLE, body: body.join('\n') },
    owner: { line: lines.join(' / '), waiting },
  }
}
