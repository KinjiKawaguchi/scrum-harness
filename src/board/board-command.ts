import { SCRUM_CLI } from '../cli-path.ts'
import { shortRepo, type Config } from '../config.ts'
import type { Flags } from '../cli-commands.ts'
import type { Ports } from '../ports/index.ts'
import type { Paths } from '../store.ts'
import { label } from './rules.ts'
import { loadSnapshot } from './snapshot.ts'
import type { BoardItem } from './types.ts'

export const BOARD_USAGE = `scrum board: put work on the board and hand it to a team
  scrum board add <N|repo#N>                        Add an issue to the board (Status Backlog, and this team's value when the board is shared)
  scrum board move <N|repo#N> --team <name>         Hand an item to another team (it leaves this team's part of the board at the next refresh)
  scrum board move --unassigned --team <name>       Give every item that has no team to that team (the first step of sharing a board)`

const REFRESH_NOTE = `The board copy changes at the next refresh (${SCRUM_CLI} refresh).`

type Ref = { readonly repo: string; readonly number: number }

/** `N` is an issue of the default repository; `name#N` names one of the configured repositories by its short name. */
function parseRef(text: string, config: Config): Ref | null {
  const [name, digits] = text.includes('#') ? text.split('#') : [undefined, text]
  if (digits === undefined || !/^\d+$/.test(digits)) return null
  const repo = name === undefined ? config.defaultRepo : config.repos.find((one) => shortRepo(one) === name)
  return repo === undefined ? null : { repo, number: Number(digits) }
}

function failure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}

function addCommand(config: Config, ports: Ports, positional: readonly string[]): string {
  const ref = parseRef(positional[1] ?? '', config)
  if (ref === null) return `pass an issue as <number> or <repo>#<number>, where the repository is one of: ${config.repos.map(shortRepo).join(', ')}`
  const { addToBoard } = ports.writer
  if (addToBoard === undefined) return 'this board cannot add an issue from here'
  try {
    addToBoard(ref.repo, ref.number)
  } catch (error) {
    return `could not add ${shortRepo(ref.repo)}#${ref.number}: ${failure(error)}`
  }
  return `added ${shortRepo(ref.repo)}#${ref.number}. ${REFRESH_NOTE}`
}

function moveTargets(p: Paths, config: Config, positional: readonly string[], flags: Flags): readonly BoardItem[] | string {
  const snapshot = loadSnapshot(p)
  if (snapshot === null) return `the board has not been read yet; run ${SCRUM_CLI} refresh`
  if (flags.unassigned === true) return snapshot.items.filter((item) => item.team === null)
  const ref = parseRef(positional[1] ?? '', config)
  if (ref === null) return 'pass an issue as <number> or <repo>#<number>, or --unassigned'
  const wanted = `${shortRepo(ref.repo)}#${ref.number}`
  const item = snapshot.items.find((one) => label(one) === wanted)
  return item === undefined ? `${wanted} is not in this team's part of the board copy (another team's item is handed over by that team; or run ${SCRUM_CLI} refresh)` : [item]
}

function moveCommand(p: Paths, config: Config, ports: Ports, positional: readonly string[], flags: Flags): string {
  if (config.team === undefined) return 'there is no team section in the configuration, so the board is not shared'
  const { setTeam } = ports.writer
  if (setTeam === undefined) return 'this board cannot hand an item to a team from here'
  const team = flags.team
  if (typeof team !== 'string' || team.trim() === '') return 'pass --team <name>, an option of the board\'s team field'
  const targets = moveTargets(p, config, positional, flags)
  if (typeof targets === 'string') return targets
  if (targets.length === 0) return 'no item to move'
  const results = targets.map((item) => {
    try {
      setTeam(item, team.trim())
      return { text: `${label(item)} -> ${team.trim()}`, isFailure: false }
    } catch (error) {
      return { text: `${label(item)}: ${failure(error)}`, isFailure: true }
    }
  })
  const failed = results.filter((one) => one.isFailure).length
  return [...results.map((one) => one.text), `${results.length - failed} moved, ${failed} failed. ${REFRESH_NOTE}`].join('\n')
}

/** `scrum board add|move`. Returns the text to print. */
export function boardCommand(p: Paths, config: Config, ports: Ports, positional: readonly string[], flags: Flags): string {
  switch (positional[0]) {
    case 'add':
      return addCommand(config, ports, positional)
    case 'move':
      return moveCommand(p, config, ports, positional, flags)
    default:
      return BOARD_USAGE
  }
}
