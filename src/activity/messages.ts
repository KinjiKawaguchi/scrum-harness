import type { SentMessage } from '../ports/index.ts'
import { eventId } from './log.ts'
import type { MessageSent } from './types.ts'

/** A recipient that is a plain name. A socket address or a path is not a participant and is left out. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/

/**
 * The message events for what one session sent. `from` is the sender's name. A message to a recipient that is not a plain name, and a message
 * to the sender itself, is left out. The summary is the sender's own label and is empty when there is none; nothing else of the message is here.
 */
export function messageEvents(sessionId: string, from: string, messages: readonly SentMessage[]): readonly MessageSent[] {
  return messages
    .filter((message) => PLAIN_NAME.test(message.to) && message.to !== from)
    .map((message) => ({ id: eventId('m', sessionId, message.toolUseId), at: new Date(message.at).toISOString(), kind: 'message', from, to: message.to, summary: message.summary }))
}
