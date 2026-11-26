import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BoardItem } from '../../board/types.ts'
import { dispatchOf, type Config } from '../../config.ts'
import type { BoardWriter } from '../../ports/index.ts'
import type { Mark } from '../../sprint/marks.ts'
import { ghEnv, type GhRun } from './gh.ts'
import { addIssueToBoard, setItemTeam } from './team-writer.ts'

/** Runs the script that rewrites the board. Throws on failure. */
export type Exec = (script: string, args: readonly string[]) => void

const SCRIPT_TIMEOUT_MS = 60_000

function scriptPath(config: Config, script: string): string {
  const dir = dispatchOf(config).scriptDir
  if (dir === undefined) return script
  return join(dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir, script)
}

export function realExec(config: Config): Exec {
  return (script, args) => {
    execFileSync(scriptPath(config, script), [...args], { timeout: SCRIPT_TIMEOUT_MS, stdio: 'ignore', env: ghEnv(config.host) })
  }
}

function fieldId(run: GhRun, config: Config, fieldName: string): string {
  const query = 'query($id:ID!, $name:String!){ node(id:$id){ ... on ProjectV2 { field(name:$name){ ... on ProjectV2FieldCommon{ id } } } } }'
  const out = run(['api', 'graphql', '-f', `query=${query}`, '-F', `id=${config.projectId}`, '-f', `name=${fieldName}`, '--jq', '.data.node.field.id'])
  const id = out.trim()
  if (id === '' || id === 'null') throw new Error(`the board has no field "${fieldName}"`)
  return id
}

/** Writes the planned values into the board's "Overrun" field. A single failure does not stop it; it returns the ones that failed. */
export function applyMarks(run: GhRun, marks: readonly Mark[], config: Config): readonly string[] {
  const fieldName = config.sprint?.overrunField
  if (fieldName === undefined || marks.length === 0) return []
  const id = fieldId(run, config, fieldName)
  return marks.flatMap((mark) => {
    const value = mark.value === null ? ['--clear'] : ['--number', String(mark.value)]
    try {
      run(['project', 'item-edit', '--project-id', config.projectId, '--id', mark.itemId, '--field-id', id, ...value])
      return []
    } catch (error) {
      return [`${mark.label}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`]
    }
  })
}

function numberOf(item: BoardItem): string {
  if (item.number === null) throw new Error(`cannot write to an item without a number: ${item.title}`)
  return String(item.number)
}

/**
 * The assignee and Status are written with the configured scripts (scripts.setAssignee, scripts.setStatus). If either is missing, writing is impossible (canAssign is false).
 * The overrun is written with gh project item-edit.
 */
export function githubBoardWriter(config: Config, exec: Exec, run: GhRun): BoardWriter {
  const { setStatus, setAssignee, setReason } = config.scripts
  return {
    canAssign: setStatus !== undefined && setAssignee !== undefined,
    assign: (item, member) => {
      if (setAssignee === undefined) throw new Error('scripts.setAssignee is not configured')
      exec(setAssignee, [numberOf(item), member])
    },
    setStatus: (item, status) => {
      if (setStatus === undefined) throw new Error('scripts.setStatus is not configured')
      exec(setStatus, [numberOf(item), status])
    },
    canSetReason: setReason !== undefined,
    setReason: (item, reason) => {
      if (setReason === undefined) throw new Error('scripts.setReason is not configured')
      exec(setReason, [numberOf(item), reason])
    },
    addToBoard: (repo, number) => addIssueToBoard(run, config, repo, number),
    setTeam: (item, team) => setItemTeam(run, config, item, team),
    writeOverrun: (marks) => applyMarks(run, marks, config),
  }
}
