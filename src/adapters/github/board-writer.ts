import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BoardItem } from '../../board/types.ts'
import { dispatchOf, type Config } from '../../config.ts'
import type { BoardWriter } from '../../ports/index.ts'
import type { Mark } from '../../sprint/marks.ts'
import type { GhRun } from './gh.ts'

/** ボードを書き換えるスクリプトを実行する。失敗したら投げる。 */
export type Exec = (script: string, args: readonly string[]) => void

const SCRIPT_TIMEOUT_MS = 60_000

function scriptPath(config: Config, script: string): string {
  const dir = dispatchOf(config).scriptDir
  if (dir === undefined) return script
  return join(dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir, script)
}

export function realExec(config: Config): Exec {
  return (script, args) => {
    execFileSync(scriptPath(config, script), [...args], { timeout: SCRIPT_TIMEOUT_MS, stdio: 'ignore' })
  }
}

function fieldId(run: GhRun, config: Config, fieldName: string): string {
  const query = 'query($id:ID!, $name:String!){ node(id:$id){ ... on ProjectV2 { field(name:$name){ ... on ProjectV2FieldCommon{ id } } } } }'
  const out = run(['api', 'graphql', '-f', `query=${query}`, '-F', `id=${config.projectId}`, '-f', `name=${fieldName}`, '--jq', '.data.node.field.id'])
  const id = out.trim()
  if (id === '' || id === 'null') throw new Error(`ボードに欄「${fieldName}」が無い`)
  return id
}

/** 計画した値をボードの「超過」の欄に書く。1件の失敗で止めず、失敗したものを返す。 */
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
  if (item.number === null) throw new Error(`番号の無い項目には書けない: ${item.title}`)
  return String(item.number)
}

/**
 * 担当と Status は、設定のスクリプト (scripts.setTanto、scripts.setStatus) で書く。どちらかが無ければ、書けない (canAssign が false)。
 * 超過は、gh project item-edit で書く。
 */
export function githubBoardWriter(config: Config, exec: Exec, run: GhRun): BoardWriter {
  const { setStatus, setTanto, setReason } = config.scripts
  return {
    canAssign: setStatus !== undefined && setTanto !== undefined,
    assign: (item, member) => {
      if (setTanto === undefined) throw new Error('scripts.setTanto が無い')
      exec(setTanto, [numberOf(item), member])
    },
    setStatus: (item, status) => {
      if (setStatus === undefined) throw new Error('scripts.setStatus が無い')
      exec(setStatus, [numberOf(item), status])
    },
    canSetReason: setReason !== undefined,
    setReason: (item, reason) => {
      if (setReason === undefined) throw new Error('scripts.setReason is not configured')
      exec(setReason, [numberOf(item), reason])
    },
    writeOverrun: (marks) => applyMarks(run, marks, config),
  }
}
