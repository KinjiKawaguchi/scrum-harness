import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { TranscriptFile, TranscriptSource } from '../ports/index.ts'
import { readJson, type Paths } from '../store.ts'
import type { UsageIndex } from './index-store.ts'

/** Drops the number that is added when a second session takes the same name ("SWE1 (2)" is "SWE1"). */
export function baseName(name: string): string {
  return name.replace(/ \(\d+\)$/, '')
}

/** Session id → name, from the identity records the hooks keep in the state directory. */
export function identityNames(p: Paths): ReadonlyMap<string, string> {
  let files: readonly string[]
  try {
    files = readdirSync(p.identity)
  } catch {
    return new Map()
  }
  return new Map(
    files
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        const record = readJson<{ readonly name?: unknown } | null>(join(p.identity, name), null)
        return typeof record?.name === 'string' ? [[basename(name, '.json'), record.name] as const] : []
      }),
  )
}

/** Where a session's name comes from, most trusted first: the hooks' identity records, the agent product's records, then the title in the transcript. */
export function sessionNames(p: Paths, source: TranscriptSource): ReadonlyMap<string, string> {
  return new Map([...source.names(), ...identityNames(p)])
}

/** The files of every project folder that holds at least one session of the team. The transcripts of other work are never read. */
export function teamFiles(files: readonly TranscriptFile[], names: ReadonlyMap<string, string>, team: ReadonlySet<string>): readonly TranscriptFile[] {
  const isTeamSession = (sessionId: string) => {
    const name = names.get(sessionId)
    return name !== undefined && team.has(baseName(name))
  }
  const projects = new Set(files.filter((file) => !file.isSubagent && isTeamSession(file.sessionId)).map((file) => file.project))
  return files.filter((file) => projects.has(file.project))
}

/** Session id → team member, for the sessions of the index that belong to the team. */
export function membersBySession(index: UsageIndex, names: ReadonlyMap<string, string>, team: ReadonlySet<string>): ReadonlyMap<string, string> {
  return new Map(
    index.sessionIds.flatMap((sessionId) => {
      const name = names.get(sessionId) ?? index.titles[sessionId]
      return name !== undefined && team.has(baseName(name)) ? [[sessionId, baseName(name)] as const] : []
    }),
  )
}
