import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Paths } from '../store.ts'

const PREFIX = 'fetch-failed-'
const KEEP = 5

/** When the fetch result could not be read, carries the raw output of the fetch as is. refreshSnapshot leaves it in the log. */
export class FetchError extends Error {
  readonly raw: string

  constructor(message: string, raw: string) {
    super(message)
    this.raw = raw
  }
}

/**
 * Leaves the output of a fetch that could not be read in log/fetch-failed-<time>.json and keeps only the newest 5.
 * This is so that what the board's host returned can be examined afterwards.
 */
export function saveFailedFetch(p: Paths, now: Date, raw: string): void {
  const dir = join(p.dir, 'log')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${PREFIX}${now.toISOString().replace(/:/g, '-')}.json`), raw)
  const saved = readdirSync(dir).filter((name) => name.startsWith(PREFIX)).toSorted()
  saved.slice(0, Math.max(0, saved.length - KEEP)).forEach((name) => rmSync(join(dir, name)))
}
