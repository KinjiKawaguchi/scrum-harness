import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptFile, TranscriptSource } from '../../ports/index.ts'
import { headOf, scanRollout } from './rollout-lines.ts'

/** Where Codex keeps its sessions. `CODEX_HOME` changes it. */
export function codexHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.CODEX_HOME ?? join(homedir(), '.codex')
}

const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

function listDir(dir: string): readonly string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Every rollout file under `sessions/`, in the folders by year, month, and day. */
function rolloutFiles(root: string): readonly { readonly path: string; readonly sessionId: string }[] {
  return listDir(root).flatMap((year) => listDir(join(root, year)).flatMap((month) => listDir(join(root, year, month)).flatMap((day) => listDir(join(root, year, month, day)).flatMap((name) => {
    const sessionId = ROLLOUT.exec(name)?.[1]
    return sessionId === undefined ? [] : [{ path: join(root, year, month, day, name), sessionId }]
  }))))
}

/** The directory a session ran in, read once from its first lines. It is the "project" the harness groups transcripts by. */
const projectOf = (() => {
  const known = new Map<string, string>()
  return (path: string, sessionId: string): string => {
    const hit = known.get(path)
    if (hit !== undefined) return hit
    let cwd = ''
    try {
      cwd = headOf(path, sessionId).cwd ?? ''
    } catch {
      return ''
    }
    if (cwd !== '') known.set(path, cwd)
    return cwd
  }
})()

/**
 * Reads the token use of Codex sessions (`<CODEX_HOME>/sessions`). A session is attributed to a member by the harness's identity record for the session id
 * (the member's hook writes it from `SCRUM_NAME`), and its project is the directory it ran in, so only the folders where a team session ran are read.
 */
export function codexTranscripts(home: string = codexHome()): TranscriptSource {
  const sessions = join(home, 'sessions')
  return {
    files: () =>
      rolloutFiles(sessions).flatMap(({ path, sessionId }): readonly TranscriptFile[] => {
        const project = projectOf(path, sessionId)
        try {
          return project === '' ? [] : [{ path, sessionId, project, isSubagent: false, size: statSync(path).size }]
        } catch {
          return []
        }
      }),
    // Codex's own titles are not the members' names; a session is named by the harness's identity record.
    names: () => new Map(),
    scan: (file, from, skipRequestIds) => scanRollout(file.path, file.sessionId, from, skipRequestIds),
  }
}
