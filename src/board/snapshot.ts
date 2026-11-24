import type { Config } from '../config.ts'
import type { BoardSource } from '../ports/index.ts'
import { recordCompletions } from '../sprint/completion.ts'
import { FetchError, saveFailedFetch } from './fetch-log.ts'
import { logError, readJson, releaseLock, tryLock, writeJson, type Paths } from '../store.ts'
import { withAssignee } from '../compat.ts'
import type { Snapshot } from './types.ts'

/** A saved board copy, with every item's `tanto` read as `assignee`. */
function readSnapshot(path: string): Snapshot | null {
  const snapshot = readJson<Snapshot | null>(path, null)
  return snapshot === null ? null : { ...snapshot, items: snapshot.items.map(withAssignee) }
}

export function loadSnapshot(p: Paths): Snapshot | null {
  return readSnapshot(p.snapshot)
}

export function saveSnapshot(p: Paths, snapshot: Snapshot): void {
  writeJson(p.snapshot, snapshot)
}

/** 最後に取り直して取れた控え。済んだ issue を見つける比べの元で、フックが Status を直して書く控え (loadSnapshot) とは別にする。 */
export function loadFetchedSnapshot(p: Paths): Snapshot | null {
  return readSnapshot(p.fetchedSnapshot)
}

export function isStale(snapshot: Snapshot | null, config: Config, now: Date): boolean {
  return snapshot === null || now.getTime() - Date.parse(snapshot.fetchedAt) > config.refreshSeconds * 1000
}

/** 控えが古く、かつ前に試してから refreshSeconds 経っているか。失敗が続いても、ボードの置き場の呼び出しの上限を使い切らないため。 */
export function isRefreshDue(p: Paths, config: Config, now: Date): boolean {
  if (!isStale(loadSnapshot(p), config, now)) return false
  const attemptedAt = readJson<string | null>(p.refreshAttempt, null)
  return attemptedAt === null || now.getTime() - Date.parse(attemptedAt) > config.refreshSeconds * 1000
}

/**
 * 作業中から済みになった issue の記録。控えは書いた後なので、失敗しても取り直しは成功のままにして、errors.log に残す。
 * 記録に成功したかを返す。失敗したら、比べの元 (最後に取った控え) を進めず、次の取り直しで、同じ issue をもう一度見つける。
 */
function noteCompletions(p: Paths, previous: Snapshot | null, fresh: Snapshot, config: Config, now: Date, source: BoardSource): boolean {
  try {
    recordCompletions(p, previous, fresh, config, now, source.statusEvents)
    return true
  } catch (error) {
    logError(p, 'completions', error)
    return false
  }
}

/** ボードを取り直して控えに書く。ほかのプロセスが取り直し中なら何もしない。 */
export function refreshSnapshot(p: Paths, config: Config, now: Date, source: BoardSource): Snapshot | null {
  if (!tryLock(p.refreshLock)) return null
  try {
    writeJson(p.refreshAttempt, now.toISOString())
    // 比べの元は、最後に取り直して取れた控え。Status を書き換えるスクリプト (scripts.setStatus) の後にフックが Status を直した控え (loadSnapshot) は、
    // すでに完了になっていて、作業中から完了への変化が見えないので使わない。まだ無ければ (この仕組みの最初)、いまの控えにする
    const previous = loadFetchedSnapshot(p) ?? loadSnapshot(p)
    const snapshot = source.fetchSnapshot(now)
    saveSnapshot(p, snapshot)
    if (noteCompletions(p, previous, snapshot, config, now, source)) writeJson(p.fetchedSnapshot, snapshot)
    return snapshot
  } catch (error) {
    logError(p, 'refresh', error)
    if (error instanceof FetchError) saveFailedFetch(p, now, error.raw)
    return null
  } finally {
    releaseLock(p.refreshLock)
  }
}
