import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addIssueToBoard, setItemTeam } from '../src/adapters/github/team-writer.ts'
import { boardCommand } from '../src/board/board-command.ts'
import { lintBoard } from '../src/board/rules.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import type { BoardItem } from '../src/board/types.ts'
import type { Config } from '../src/config.ts'
import { paths, type Paths } from '../src/store.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, issue, NOW, REPO, snapshot } from './helpers.ts'

const config: Config = { ...base, team: { field: 'Team', value: 'node', adoptsUnassigned: true } }
let p: Paths
let added: { repo: string; number: number }[]
let moved: { label: string; team: string }[]

const ports = (failOn?: number) => {
  const base = fakePorts()
  return {
    ...base,
    writer: {
      ...base.writer,
      addToBoard: (repo: string, number: number) => void added.push({ repo, number }),
      setTeam: (item: BoardItem, team: string) => {
        if (item.number === failOn) throw new Error('gh failed')
        moved.push({ label: `${item.number}`, team })
      },
    },
  }
}

beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-board-command-')))
  added = []
  moved = []
  saveSnapshot(p, snapshot([issue(1, { team: 'node' }), issue(2, { team: null }), issue(3, { team: null })]))
})

describe('scrum board add', () => {
  it('adds an issue of the default repository by its number, and one of another repository by its short name', () => {
    assert.match(boardCommand(p, config, ports(), ['add', '7'], {}), /^added app#7\./)
    assert.match(boardCommand(p, config, ports(), ['add', 'app-mobile#9'], {}), /^added app-mobile#9\./)
    assert.deepEqual(added, [{ repo: REPO, number: 7 }, { repo: 'example-org/app-mobile', number: 9 }])
  })

  it('refuses what is not an issue of a configured repository, and says what it could not do', () => {
    for (const ref of ['', 'x', 'other#1', '1.5', '#4']) assert.match(boardCommand(p, config, ports(), ['add', ref], {}), /pass an issue as/, ref)
    assert.deepEqual(added, [])
    const failing = { ...ports(), writer: { ...ports().writer, addToBoard: () => { throw new Error('no access') } } }
    assert.match(boardCommand(p, config, failing, ['add', '7'], {}), /could not add app#7: no access/)
  })
})

describe('scrum board move', () => {
  it('hands one of this team\'s items to another team', () => {
    assert.match(boardCommand(p, config, ports(), ['move', '1'], { team: 'clients' }), /app#1 -> clients\n1 moved, 0 failed/)
    assert.deepEqual(moved, [{ label: '1', team: 'clients' }])
  })

  it('gives every item with no team to a team with --unassigned, and goes on after a failure', () => {
    const text = boardCommand(p, config, ports(2), ['move'], { unassigned: true, team: 'node' })
    assert.match(text, /app#2: gh failed/)
    assert.match(text, /1 moved, 1 failed/)
    assert.deepEqual(moved, [{ label: '3', team: 'node' }])
  })

  it('does not move an item that is not in this team\'s part of the board copy', () => {
    assert.match(boardCommand(p, config, ports(), ['move', '99'], { team: 'clients' }), /not in this team's part/)
    assert.deepEqual(moved, [])
  })

  it('needs a team section and a team name', () => {
    assert.match(boardCommand(p, base, ports(), ['move', '1'], { team: 'clients' }), /no team section/)
    assert.match(boardCommand(p, config, ports(), ['move', '1'], {}), /pass --team/)
    assert.deepEqual(moved, [])
  })

  it('shows the usage for anything else', () => {
    assert.match(boardCommand(p, config, ports(), [], {}), /scrum board: /)
  })
})

describe('B-NO-TEAM and the off-board fix on a shared board', () => {
  const rules = (cfg: Config, items: readonly BoardItem[], open?: Parameters<typeof snapshot>[1]) => lintBoard(snapshot(items, open), cfg, NOW)

  it('is raised for an open issue with no team, for the team that adopts unassigned work only', () => {
    const items = [issue(1, { team: 'node' }), issue(2, { team: null }), issue(3, { team: null, state: 'CLOSED', status: 'Done' })]
    assert.deepEqual(rules(config, items).map((f) => `${f.rule} ${f.subject}`), ['B-NO-TEAM app#2'])
    assert.match(rules(config, items)[0]?.fix ?? '', /board move app#2 --team <name>$/)
    assert.deepEqual(rules({ ...config, team: { ...config.team!, adoptsUnassigned: false } }, items), [])
    assert.deepEqual(rules(base, [issue(2)]), [])
  })

  it('names `scrum board add` as the fix for an issue that is not on the board', () => {
    const [finding] = rules(config, [issue(1, { team: 'node' })], [{ repo: REPO, number: 5, author: 'owner' }])
    assert.deepEqual([finding?.rule, finding?.fix?.endsWith('board add app#5')], ['B-OFF-BOARD', true])
    assert.match(rules(base, [issue(1)], [{ repo: REPO, number: 5, author: 'owner' }])[0]?.fix ?? '', /^set-status 5 Backlog$/)
  })
})

/** A fake gh for the GraphQL calls the writer makes: one answer per recognizable query. */
function fakeGh(options: { status: string | null; fields?: Record<string, readonly string[]> }) {
  const calls: string[][] = []
  const fields = options.fields ?? { Status: ['Backlog', 'Next'], Team: ['node', 'clients'] }
  const run = (args: readonly string[]): string => {
    calls.push([...args])
    const query = args.find((arg) => arg.startsWith('query='))?.slice(6) ?? ''
    if (args[0] === 'api' && args[1]?.startsWith('repos/')) return JSON.stringify({ node_id: 'I_node' })
    if (query.includes('addProjectV2ItemById')) return JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'PVTI_new' } } } })
    if (query.includes('fieldValueByName')) return JSON.stringify({ data: { node: { status: options.status === null ? null : { name: options.status } } } })
    const name = args[args.indexOf('-f', args.indexOf('-F') + 1) + 1]?.replace(/^name=/, '') ?? ''
    const names = fields[name]
    return JSON.stringify({ data: { node: { field: names === undefined ? null : { id: `F_${name}`, options: names.map((one) => ({ id: `O_${one}`, name: one })) } } } })
  }
  const edits = () => calls.filter((call) => call[1] === 'item-edit').map((call) => `${call[call.indexOf('--field-id') + 1]}=${call[call.indexOf('--single-select-option-id') + 1]}`)
  return { run, edits }
}

describe('adding to the board with gh', () => {
  it('sets Backlog on a new item and this team\'s value in the team field', () => {
    const gh = fakeGh({ status: null })
    addIssueToBoard(gh.run, config, REPO, 7)
    assert.deepEqual(gh.edits(), ['F_Status=O_Backlog', 'F_Team=O_node'])
  })

  it('keeps the Status of an item that is already on the board', () => {
    const gh = fakeGh({ status: 'Next' })
    addIssueToBoard(gh.run, config, REPO, 7)
    assert.deepEqual(gh.edits(), ['F_Team=O_node'])
  })

  it('writes no team without a team section, and refuses what is not an issue', () => {
    const gh = fakeGh({ status: null })
    addIssueToBoard(gh.run, base, REPO, 7)
    assert.deepEqual(gh.edits(), ['F_Status=O_Backlog'])
    assert.throws(() => addIssueToBoard(gh.run, config, 'not a repo', 7), /not an issue/)
    assert.throws(() => addIssueToBoard(gh.run, config, REPO, 1.5), /not an issue/)
  })

  it('sets the team of an item, and names the options when the team is not one of them', () => {
    const gh = fakeGh({ status: null })
    setItemTeam(gh.run, config, issue(4), 'clients')
    assert.deepEqual(gh.edits(), ['F_Team=O_clients'])
    assert.throws(() => setItemTeam(gh.run, config, issue(4), 'clinets'), /"clinets" is not an option of the board's "Team" field \(node, clients\)/)
    assert.throws(() => setItemTeam(fakeGh({ status: null, fields: {} }).run, config, issue(4), 'node'), /no single-select field "Team"/)
  })
})
