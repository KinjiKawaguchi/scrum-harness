import type { BoardItem } from '../../board/types.ts'
import type { Config } from '../../config.ts'
import { optionIdOf, singleSelectField, type SingleSelectField } from './field-options.ts'
import type { GhRun } from './gh.ts'

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function requiredField(run: GhRun, config: Config, name: string): SingleSelectField {
  const field = singleSelectField(run, config, name)
  if (field === null) throw new Error(`the board has no single-select field "${name}"`)
  return field
}

function setOption(run: GhRun, config: Config, itemId: string, field: SingleSelectField, fieldName: string, option: string): void {
  run(['project', 'item-edit', '--project-id', config.projectId, '--id', itemId, '--field-id', field.id, '--single-select-option-id', optionIdOf(field, fieldName, option)])
}

/** Sets the team field of an item. The item then belongs to that team's part of the board. */
export function setItemTeam(run: GhRun, config: Config, item: BoardItem, team: string): void {
  const scope = config.team
  if (scope === undefined) throw new Error('there is no team section in the configuration, so there is no team field to set')
  setOption(run, config, item.itemId, requiredField(run, config, scope.field), scope.field, team)
}

function currentStatus(run: GhRun, config: Config, itemId: string): string | null {
  const query = `query($id:ID!){ node(id:$id){ ... on ProjectV2Item { status: fieldValueByName(name:"${config.fields.status}"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } } }`
  const out = run(['api', 'graphql', '-f', `query=${query}`, '-f', `id=${itemId}`])
  return (JSON.parse(out) as { data?: { node?: { status?: { name?: string } | null } | null } }).data?.node?.status?.name ?? null
}

/**
 * Adds an issue to the board. A new item gets Status Backlog (an item that is already on the board keeps its Status) and, when the board is shared,
 * this team's value in the team field. Adding an issue that is already on the board is not an error.
 */
export function addIssueToBoard(run: GhRun, config: Config, repo: string, number: number): void {
  if (!REPO.test(repo) || !Number.isInteger(number)) throw new Error(`not an issue: ${repo}#${number}`)
  const contentId = JSON.parse(run(['api', `repos/${repo}/issues/${number}`])).node_id
  if (typeof contentId !== 'string') throw new Error(`cannot read ${repo}#${number}`)
  const mutation = 'mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }'
  const itemId = JSON.parse(run(['api', 'graphql', '-f', `query=${mutation}`, '-f', `p=${config.projectId}`, '-f', `c=${contentId}`])).data?.addProjectV2ItemById?.item?.id
  if (typeof itemId !== 'string') throw new Error(`could not add ${repo}#${number} to the board`)
  if (currentStatus(run, config, itemId) === null) setOption(run, config, itemId, requiredField(run, config, config.fields.status), config.fields.status, config.statuses.backlog)
  const scope = config.team
  if (scope !== undefined) setOption(run, config, itemId, requiredField(run, config, scope.field), scope.field, scope.value)
}
