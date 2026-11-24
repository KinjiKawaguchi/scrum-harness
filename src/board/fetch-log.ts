import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Paths } from '../store.ts'

const PREFIX = 'fetch-failed-'
const KEEP = 5

/** 取得の結果を読めなかったとき、取得の生の出力をそのまま持ち運ぶ。refreshSnapshot が log に残す。 */
export class FetchError extends Error {
  readonly raw: string

  constructor(message: string, raw: string) {
    super(message)
    this.raw = raw
  }
}

/**
 * 読めなかった取得の出力を log/fetch-failed-<時刻>.json に残し、新しい5件だけを保つ。
 * ボードの置き場が何を返したかを、後から調べられるようにするため。
 */
export function saveFailedFetch(p: Paths, now: Date, raw: string): void {
  const dir = join(p.dir, 'log')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${PREFIX}${now.toISOString().replace(/:/g, '-')}.json`), raw)
  const saved = readdirSync(dir).filter((name) => name.startsWith(PREFIX)).toSorted()
  saved.slice(0, Math.max(0, saved.length - KEEP)).forEach((name) => rmSync(join(dir, name)))
}
