import type { Config } from '../config.ts'
import { NOTICE_TITLE } from './text.ts'
import type { Notice } from './types.ts'

/**
 * 1 回の評価で出たオーナーへの通知を、1 通にまとめる。macOS の通知も 1 つ、窓口への PushNotification も 1 通になる。
 * 1 件ならそのまま。2 件以上なら、1 件ごとに 1 行 (止まっている理由つき) に並べる。まとめた通知は、まとめた分の指紋をすべて持つ
 * (出した印は、まとめた分の全部に付ける)。
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
