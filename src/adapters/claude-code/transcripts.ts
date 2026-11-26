import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TranscriptFile, TranscriptSource } from '../../ports/index.ts'
import { readJson } from '../../store.ts'
import { claudeConfigDirs, projectsDirs, sessionsDirs } from './config-dirs.ts'
import { readSessionRecordsIn } from './sessions.ts'
import { scanFile } from './transcript-lines.ts'

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/

function listDir(dir: string): readonly string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function fileOf(path: string, sessionId: string, project: string, isSubagent: boolean): TranscriptFile | null {
  try {
    return { path, sessionId, project, isSubagent, size: statSync(path).size }
  } catch {
    return null
  }
}

/** The transcript of each session in one project folder, and under it the transcripts of the subagents that session started. */
export function transcriptsIn(projectDir: string): readonly TranscriptFile[] {
  return listDir(projectDir)
    .filter((name) => SESSION_FILE.test(name))
    .flatMap((name) => {
      const sessionId = name.slice(0, -'.jsonl'.length)
      const subDir = join(projectDir, sessionId, 'subagents')
      const subagents = listDir(subDir).filter((one) => one.endsWith('.jsonl')).map((one) => fileOf(join(subDir, one), sessionId, projectDir, true))
      return [fileOf(join(projectDir, name), sessionId, projectDir, false), ...subagents].flatMap((one) => (one === null ? [] : [one]))
    })
}

/** Session id → name, from Claude Code's session records and from the custom-title.json a session keeps in its folder. */
export function recordedNames(sessionRecords: readonly { readonly sessionId?: unknown; readonly name?: unknown }[], root: string): ReadonlyMap<string, string> {
  const fromSessions = sessionRecords.flatMap((record) => (typeof record.sessionId === 'string' && typeof record.name === 'string' ? [[record.sessionId, record.name] as const] : []))
  const fromTitles = listDir(root).flatMap((dir) =>
    listDir(join(root, dir)).flatMap((sessionId) => {
      const path = join(root, dir, sessionId, 'custom-title.json')
      const title = existsSync(path) ? readJson<{ readonly customTitle?: unknown } | null>(path, null)?.customTitle : undefined
      return typeof title === 'string' ? [[sessionId, title] as const] : []
    }),
  )
  return new Map([...fromTitles, ...fromSessions])
}

/**
 * Reads the transcripts under `projects` of each configuration directory (SCRUM_PROJECTS_DIR replaces them with one folder). It is Claude Code's internal
 * layout and is not public. The index remembers each transcript by its full path, so two directories never collide.
 */
export function claudeCodeTranscripts(
  roots: readonly string[] = projectsDirs(claudeConfigDirs(undefined)),
  sessionFolders: readonly string[] = sessionsDirs(claudeConfigDirs(undefined)),
): TranscriptSource {
  return {
    files: () => roots.flatMap((root) => listDir(root).flatMap((dir) => transcriptsIn(join(root, dir)))),
    names: () => new Map(roots.flatMap((root) => [...recordedNames(readSessionRecordsIn(sessionFolders), root)])),
    scan: (file, from, skipRequestIds) => scanFile(file.path, from, skipRequestIds),
  }
}
