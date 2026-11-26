import { readJson } from '../store.ts'

/** A member that was told to go on, for the idle stretch that began at `idleSince`: what the notice says. */
export type ContinuedRecord = {
  readonly idleSince: string
  readonly at: string
  /** How long it had been idle when it was told */
  readonly minutes: number
  /** The issues it had In Progress, none when it had none */
  readonly items: readonly string[]
  /** Whether the line left the input box (false: it was typed and is still there) */
  readonly isSubmitted: boolean
}

/** The idle stretch each member was last told to go on in: what keeps one stretch from being told twice. */
export type Continued = Readonly<Record<string, ContinuedRecord>>

export const readContinued = (path: string): Continued => readJson<Continued>(path, {})

/** The one-line notice: who was told, after how long, and which case it was (the issues In Progress, or none). */
export function continuedNotice(name: string, record: Pick<ContinuedRecord, 'minutes' | 'items' | 'isSubmitted'>): string {
  const case_ = record.items.length === 0 ? 'no In Progress item' : `${record.items.join(', ')} In Progress`
  return `${name} was idle at its prompt for ${record.minutes} minutes (${case_}); the harness typed its continuation text${record.isSubmitted ? '' : ' (the line is still in its input box: it was not submitted)'}`
}

