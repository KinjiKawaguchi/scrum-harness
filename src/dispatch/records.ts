import { appendLine, readText, type Paths } from '../store.ts'
import type { DispatchRecord } from './types.ts'

/** Reads the record of work handed over. Unreadable lines are dropped. */
export function readDispatches(p: Paths): readonly DispatchRecord[] {
  return readText(p.dispatches)
    .split('\n')
    .filter((line) => line !== '')
    .flatMap((line): readonly DispatchRecord[] => {
      try {
        const record = JSON.parse(line) as Partial<DispatchRecord>
        const isValid = typeof record.at === 'string' && typeof record.member === 'string' && typeof record.label === 'string' && typeof record.title === 'string'
        return isValid ? [record as DispatchRecord] : []
      } catch {
        return []
      }
    })
}

export function appendDispatch(p: Paths, record: DispatchRecord): void {
  appendLine(p.dispatches, JSON.stringify(record))
}
