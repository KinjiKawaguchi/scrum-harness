import type { Config } from '../config.ts'
import type { Ports } from '../ports/index.ts'
import { releaseLock, tryLock, type Paths } from '../store.ts'
import { appendEvents, trimLog } from '../activity/log.ts'
import { messageEvents } from '../activity/messages.ts'
import { teamFiles, baseName, sessionNames } from './attribution.ts'
import { readIndex, updateIndex, type OnMessages } from './index-store.ts'

/** The sessions whose usage is reported: the TechLead and the members (the people of the team view). */
export const teamNamesOf = (config: Config): ReadonlySet<string> => new Set([config.techlead, ...config.members].map(baseName))

/** An index older than this is read again in the background. */
export const INDEX_STALE_MS = 5 * 60_000

export function isIndexStale(p: Paths, now: Date): boolean {
  const index = readIndex(p.usageIndex)
  return index === null || now.getTime() - Date.parse(index.updatedAt) >= INDEX_STALE_MS
}

/**
 * Reads what the team's transcripts gained since the last run and saves the index. The first run reads every transcript of the team's
 * projects, which can be gigabytes, so it runs in its own process. Only one runs at a time. Returns null if another is running.
 */
export function runUsageIndex(p: Paths, config: Config, transcripts: Ports['transcripts'], now: Date): { readonly files: number; readonly rows: number } | null {
  if (!tryLock(p.usageLock)) return null
  try {
    const names = sessionNames(p, transcripts)
    const team = teamNamesOf(config)
    const files = teamFiles(transcripts.files(), names, team)
    // The messages the team's sessions sent go to the activity log as they are read; the index itself keeps only token use.
    const onMessages: OnMessages = (file, messages) => {
      const name = file.isSubagent ? undefined : names.get(file.sessionId)
      if (name !== undefined && team.has(baseName(name))) appendEvents(p.activityLog, messageEvents(file.sessionId, baseName(name), messages), now)
    }
    const index = updateIndex(p.usageIndex, files, transcripts, now, onMessages)
    trimLog(p.activityLog, now)
    return { files: files.length, rows: index.rows.length }
  } finally {
    releaseLock(p.usageLock)
  }
}
