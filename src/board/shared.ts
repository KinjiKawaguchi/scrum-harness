import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Config } from '../config.ts'
import type { BoardSource, GraphqlCost, WholeBoard } from '../ports/index.ts'
import { isReadHeld } from './allowance.ts'
import { readJson, releaseLock, tryLock, type Paths, writeJson } from '../store.ts'
import type { Snapshot } from './types.ts'

/**
 * Where the board copies that teams share are kept: one directory for the machine's user, as the teams' state directories are the user's. `SCRUM_SHARED_DIR`
 * sets it, and `off` turns sharing off (each team reads the board on its own). Under node's test runner, which sets NODE_TEST_CONTEXT, sharing is off unless
 * a directory is set, so that a test never writes to the user's real directory.
 */
export function sharedDir(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const set = env.SCRUM_SHARED_DIR
  if (set === 'off' || ((set === undefined || set === '') && env.NODE_TEST_CONTEXT !== undefined)) return null
  return set === undefined || set === '' ? join(homedir(), '.claude', 'scrum-shared') : set
}

/** A board read that is kept for the teams of one machine that read the same board. */
type Entry = { readonly version: 1; readonly key: string; readonly fetchedAt: string; readonly board: WholeBoard }

const isEntry = (value: unknown, key: string): value is Entry => {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<Entry>
  return entry.version === 1 && entry.key === key && typeof entry.fetchedAt === 'string' && !Number.isNaN(Date.parse(entry.fetchedAt)) && Array.isArray(entry.board?.items) && Array.isArray(entry.board?.openIssues)
}

/** How the board copy of a refresh was obtained. `private` is a read the team made on its own (no sharing); `held` is a copy kept because a read would have used the points others need. */
export type Via = 'fetched' | 'shared' | 'private' | 'held'

/** What the last refresh did and what it cost, kept for `scrum refresh`'s words and the finding that warns of a low allowance. */
export type CostRecord = {
  readonly at: string
  readonly via: Via
  /** When the board was read (for a shared copy, by whichever team read it) */
  readonly boardAt: string
  readonly cost?: GraphqlCost
}

export const readCostRecord = (path: string): CostRecord | null => {
  const value = readJson<Partial<CostRecord> | null>(path, null)
  return value !== null && typeof value.at === 'string' && typeof value.boardAt === 'string' && (value.via === 'fetched' || value.via === 'shared' || value.via === 'private' || value.via === 'held') ? (value as CostRecord) : null
}

/** Thrown when a read of the board is held back and there is no copy to use in its place. The refresh keeps the board copy it has. */
export class BoardReadHeld extends Error {
  constructor() {
    super('the board read is held back while the hour\'s GraphQL points are nearly used up')
    this.name = 'BoardReadHeld'
  }
}

export type Obtained = { readonly snapshot: Snapshot; readonly via: Via; readonly boardAt: string; readonly cost?: GraphqlCost }

function writeEntry(path: string, entry: Entry): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * The board for a refresh. Teams that read the same board (the source's `shared.key`) share one read: the first refresh that finds the shared copy older
 * than the team's `refreshSeconds` reads the board, under a lock, and writes it for the others, who narrow it to their own team. A refresh that finds
 * another reading takes the copy there is, however old, rather than read a second time; with none, it reads on its own. A source that cannot be
 * shared, or sharing turned off, reads as it always did.
 */
export function obtainBoard(p: Paths, config: Config, now: Date, source: BoardSource, directory: string | null = sharedDir()): Obtained {
  const shared = source.shared
  // A read that would be made waits while the hour's points are low; the copy there is, however old, is used instead, and with none the refresh does nothing.
  const holdsRead = (copy: Entry | null): boolean => isReadHeld(shared?.allowance?.() ?? null, copy?.fetchedAt ?? null, config.refreshSeconds, now)
  if (shared === undefined || directory === null) {
    if (holdsRead(null)) throw new BoardReadHeld()
    return { snapshot: source.fetchSnapshot(now), via: 'private', boardAt: now.toISOString() }
  }
  const path = join(directory, `board-${shared.key}.json`)
  const read = (): Entry | null => {
    const value = readJson<unknown>(path, null)
    return isEntry(value, shared.key) ? value : null
  }
  const isFresh = (entry: Entry | null): entry is Entry => entry !== null && now.getTime() - Date.parse(entry.fetchedAt) < config.refreshSeconds * 1000
  const from = (entry: Entry, via: Via): Obtained => ({ snapshot: { ...shared.scope(entry.board, now), fetchedAt: entry.fetchedAt }, via, boardAt: entry.fetchedAt, ...(entry.board.cost === undefined ? {} : { cost: entry.board.cost }) })
  const found = read()
  if (isFresh(found)) return from(found, 'shared')
  const lock = `${path}.lock`
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!tryLock(lock)) {
    // Someone is reading it now: the copy there is, however old, is better than a second read.
    return found !== null ? from(found, 'shared') : { snapshot: source.fetchSnapshot(now), via: 'private', boardAt: now.toISOString() }
  }
  try {
    const again = read()
    if (isFresh(again)) return from(again, 'shared')
    if (holdsRead(again)) {
      if (again === null) throw new BoardReadHeld()
      return from(again, 'held')
    }
    const board = shared.readWhole(now)
    const entry: Entry = { version: 1, key: shared.key, fetchedAt: now.toISOString(), board }
    writeEntry(path, entry)
    return from(entry, 'fetched')
  } finally {
    releaseLock(lock)
  }
}

/** Keeps what the refresh did and what it cost. */
export function recordCost(path: string, obtained: Obtained, now: Date): void {
  writeJson(path, { at: now.toISOString(), via: obtained.via, boardAt: obtained.boardAt, ...(obtained.cost === undefined ? {} : { cost: obtained.cost }) } satisfies CostRecord)
}
