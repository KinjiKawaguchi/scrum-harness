import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_ID = /^[0-9A-Za-z-]{8,64}$/

/** Whether `<configDir>/projects/<project>/<sessionId>.jsonl` exists (a project folder may be a symlink to another login's). */
export function claudeTranscriptIn(configDir: string, sessionId: string): boolean {
  if (!SESSION_ID.test(sessionId)) return false
  try {
    return readdirSync(join(configDir, 'projects')).some((project) => existsSync(join(configDir, 'projects', project, `${sessionId}.jsonl`)))
  } catch {
    return false
  }
}
