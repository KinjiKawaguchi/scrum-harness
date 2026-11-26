import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertTeamValue } from '../src/adapters/github/team-field.ts'
import { fetchSnapshot } from '../src/adapters/github/project-board.ts'
import { itemNodeSelection } from '../src/adapters/github/item-node.ts'
import { parseTeamScope, scopeToTeam, type TeamScope } from '../src/board/team-scope.ts'
import { parseConfig, type Config } from '../src/config.ts'
import { config as base, issue, REPO } from './helpers.ts'

const own: TeamScope = { field: 'Team', value: 'node', adoptsUnassigned: false }
const adopting: TeamScope = { ...own, adoptsUnassigned: true }
const config: Config = { ...base, team: own }

const open = (number: number) => ({ repo: REPO, number, author: 'owner' })
const items = [issue(1, { team: 'node' }), issue(2, { team: 'clients' }), issue(3, { team: null }), issue(4, { team: 'node', state: 'CLOSED' })]
const openIssues = [open(1), open(2), open(3), open(5)]

describe('parseTeamScope', () => {
  it('is absent when the section is absent, and reads the value and whether the team adopts unassigned work', () => {
    assert.equal(parseTeamScope(undefined), undefined)
    assert.deepEqual(parseTeamScope({ field: 'Team', value: 'node' }), own)
    assert.deepEqual(parseTeamScope({ field: 'Team', value: 'node', adoptsUnassigned: true }), adopting)
  })

  it('is null for a section of the wrong shape, so it never falls back to the whole board', () => {
    for (const raw of [null, 'node', [], {}, { field: 'Team' }, { value: 'node' }, { field: '', value: 'node' }, { field: 'Team', value: 'node', adoptsUnassigned: 'yes' }]) {
      assert.equal(parseTeamScope(raw), null, JSON.stringify(raw))
    }
  })

  it('makes a configuration with a malformed team section unusable instead of widening it to the whole board', () => {
    const raw = { ...base, team: { field: 'Team' } }
    assert.equal(parseConfig(raw), null)
    assert.deepEqual(parseConfig({ ...base, team: { field: 'Team', value: 'node' } })?.team, own)
    assert.equal(parseConfig(base)?.team, undefined)
  })
})

describe('scopeToTeam', () => {
  it('leaves the board as it is when there is no team section', () => {
    assert.deepEqual(scopeToTeam(items, openIssues, undefined), { items, openIssues })
  })

  it('keeps only the team\'s items, and only the open issues that are its own', () => {
    const scoped = scopeToTeam(items, openIssues, own)
    assert.deepEqual(scoped.items.map((item) => item.number), [1, 4])
    assert.deepEqual(scoped.openIssues.map((one) => one.number), [1])
  })

  it('lets the adopting team also own the unassigned items and the issues that are not on the board, but not another team\'s', () => {
    const scoped = scopeToTeam(items, openIssues, adopting)
    assert.deepEqual(scoped.items.map((item) => item.number), [1, 3, 4])
    assert.deepEqual(scoped.openIssues.map((one) => one.number), [1, 3, 5])
  })

  it('does not report another team\'s issue as off the board', () => {
    const scoped = scopeToTeam(items, openIssues, adopting)
    assert.equal(scoped.openIssues.some((one) => one.number === 2), false)
  })

  it('matches an issue to its item by the repository\'s short name and the number', () => {
    const scoped = scopeToTeam([issue(1, { repo: 'Example-Org/app', team: 'clients' })], [{ repo: 'example-org/app', number: 1, author: null }], adopting)
    assert.deepEqual(scoped.openIssues, [])
  })
})

describe('reading the team field', () => {
  it('reads the field only when the team is scoped', () => {
    assert.match(itemNodeSelection(config), /team: fieldValueByName\(name:"Team"\)/)
    assert.doesNotMatch(itemNodeSelection(base), /team:/)
  })
})

const optionsReply = (names: readonly string[] | null) => JSON.stringify({ data: { node: { field: names === null ? null : { options: names.map((name) => ({ name })) } } } })
const runOptions = (names: readonly string[] | null) => () => optionsReply(names)

describe('assertTeamValue', () => {
  it('does nothing without a team section, and accepts a value that is an option', () => {
    assert.doesNotThrow(() => assertTeamValue(() => assert.fail('no call expected'), base))
    assert.doesNotThrow(() => assertTeamValue(runOptions(['node', 'clients']), config))
  })

  it('fails, naming the options, when the value is not one of them (a misspelling would show an empty board and no findings)', () => {
    assert.throws(() => assertTeamValue(runOptions(['Node', 'clients']), config), /"node" \(team\.value\) is not an option .*Node, clients/)
  })

  it('fails when the board has no such field', () => {
    assert.throws(() => assertTeamValue(runOptions(null), config), /no single-select field "Team"/)
  })
})

const node = (number: number, team: string | null) => ({
  id: `PVTI_${number}`,
  type: 'ISSUE',
  status: { name: 'Backlog' },
  reason: { name: 'None' },
  team: team === null ? null : { name: team },
  content: { number, title: `issue ${number}`, state: 'OPEN', author: { login: 'owner' }, repository: { nameWithOwner: REPO } },
})

/** A gh that answers the calls fetchSnapshot makes: the field's options, the board's pages, and the open issues and PRs. */
function fakeGh(teams: readonly (string | null)[], openNumbers: readonly number[]): (args: readonly string[]) => string {
  return (args) => {
    if (args[0] === 'issue') return JSON.stringify(openNumbers.map((number) => ({ number, author: { login: 'owner' } })))
    if (args[0] === 'pr') return '[]'
    if (args.includes('--paginate')) return JSON.stringify([{ data: { node: { items: { totalCount: teams.length, nodes: teams.map((team, index) => node(index + 1, team)) } } } }])
    return optionsReply(['node', 'clients'])
  }
}

describe('fetchSnapshot with a team', () => {
  const now = new Date('2026-10-08T06:00:00.000Z')
  const teams = ['node', 'clients', null, 'node']

  it('narrows the whole board to the team: its items, and no other team\'s issue as off the board', () => {
    const run = fakeGh(teams, [1, 2, 3, 4])
    const snapshot = fetchSnapshot(run, { ...config, repos: [REPO] }, now)
    assert.deepEqual(snapshot.items.map((item) => [item.number, item.team]), [[1, 'node'], [4, 'node']])
    assert.deepEqual(snapshot.openIssues.map((one) => one.number), [1, 4])
  })

  it('shows the adopting team the unassigned items too', () => {
    const run = fakeGh(teams, [1, 2, 3, 4])
    const snapshot = fetchSnapshot(run, { ...config, team: adopting, repos: [REPO] }, now)
    assert.deepEqual(snapshot.items.map((item) => item.number), [1, 3, 4])
    assert.deepEqual(snapshot.openIssues.map((one) => one.number), [1, 3, 4])
  })

  it('still reads the whole board for the check that a read did not fail: a team with no items yet is not a failed read', () => {
    const run = fakeGh(['clients', 'clients', 'clients'], [1, 2, 3])
    const snapshot = fetchSnapshot(run, { ...config, repos: [REPO] }, now)
    assert.deepEqual([snapshot.items, snapshot.openIssues], [[], []])
  })
})
