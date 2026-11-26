import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchSnapshot } from '../src/adapters/github/project-board.ts'
import { lintBoard } from '../src/board/rules.ts'
import { parseOffBoardScope, watchedIssues, type OffBoardScope } from '../src/board/off-board-scope.ts'
import type { OpenIssue } from '../src/board/types.ts'
import { parseConfig, type Config } from '../src/config.ts'
import { config as base, NOW, REPO } from './helpers.ts'

const open = (number: number, labels: readonly string[] = [], assignees: readonly string[] = []): OpenIssue => ({ repo: REPO, number, author: 'owner', labels, assignees })
const filter: OffBoardScope = { scope: 'filter', labels: ['team:loom'], assignees: ['alice'] }

describe('parseOffBoardScope', () => {
  it('is absent when the section is absent, and reads each scope', () => {
    assert.equal(parseOffBoardScope(undefined), undefined)
    assert.deepEqual(parseOffBoardScope({ scope: 'all' }), { scope: 'all' })
    assert.deepEqual(parseOffBoardScope({ scope: 'none' }), { scope: 'none' })
    assert.deepEqual(parseOffBoardScope({ scope: 'filter', labels: ['team:loom'] }), { scope: 'filter', labels: ['team:loom'], assignees: [] })
    assert.deepEqual(parseOffBoardScope({ scope: 'filter', assignees: ['alice'] }), { scope: 'filter', labels: [], assignees: ['alice'] })
  })

  it('is null for a section of the wrong shape, so it never falls back to every open issue', () => {
    const wrong = [null, 'none', [], {}, { scope: 'some' }, { scope: 'filter' }, { scope: 'filter', labels: [] }, { scope: 'filter', labels: [''] }, { scope: 'filter', labels: 'x' }, { scope: 'none', labels: ['x'] }]
    for (const raw of wrong) assert.equal(parseOffBoardScope(raw), null, JSON.stringify(raw))
    assert.equal(parseConfig({ ...base, offBoard: { scope: 'filter' } }), null)
    assert.deepEqual(parseConfig({ ...base, offBoard: { scope: 'none' } })?.offBoard, { scope: 'none' })
    assert.equal(parseConfig(base)?.offBoard, undefined)
  })
})

describe('watchedIssues', () => {
  const issues = [open(1, ['team:loom']), open(2, ['team:other']), open(3, [], ['alice']), open(4)]

  it('keeps every issue without a scope or with `all`, and none with `none`', () => {
    assert.deepEqual(watchedIssues(issues, undefined), issues)
    assert.deepEqual(watchedIssues(issues, { scope: 'all' }), issues)
    assert.deepEqual(watchedIssues(issues, { scope: 'none' }), [])
  })

  it('keeps an issue with a listed label or a listed assignee, and no other', () => {
    assert.deepEqual(watchedIssues(issues, filter).map((one) => one.number), [1, 3])
  })

  it('keeps nothing when the labels and assignees were not read', () => {
    assert.deepEqual(watchedIssues([{ repo: REPO, number: 1, author: null }], filter), [])
  })
})

/** A fake gh that records the issue-list calls and answers the board's pages and the open issues. */
function fakeGh(onBoard: readonly number[], rawOpen: readonly object[]) {
  const issueLists: string[][] = []
  const run = (args: readonly string[]): string => {
    if (args[0] === 'issue') {
      issueLists.push([...args])
      return JSON.stringify(rawOpen)
    }
    if (args[0] === 'pr') return '[]'
    if (!args.includes('--paginate')) {
      // The one-by-one read of issues that look off the board: none of them is on the board.
      const aliases = [...(args.find((arg) => arg.startsWith('query='))?.matchAll(/\bc(\d+):/g) ?? [])].map((match) => `c${match[1]}`)
      return JSON.stringify({ data: Object.fromEntries(aliases.map((alias) => [alias, { issue: { projectItems: { nodes: [] } } }])) })
    }
    const nodes = onBoard.map((number) => ({ id: `PVTI_${number}`, type: 'ISSUE', status: { name: 'Backlog' }, reason: { name: 'None' }, content: { number, title: `issue ${number}`, state: 'OPEN', author: { login: 'owner' }, repository: { nameWithOwner: REPO } } }))
    return JSON.stringify([{ data: { node: { items: { totalCount: nodes.length, nodes } } } }])
  }
  return { run, issueLists }
}

const rawIssue = (number: number, labels: readonly string[] = [], assignees: readonly string[] = []) => ({ number, author: { login: 'owner' }, labels: labels.map((name) => ({ name })), assignees: assignees.map((login) => ({ login })) })
const withScope = (offBoard: OffBoardScope | undefined): Config => ({ ...base, repos: [REPO], ...(offBoard === undefined ? {} : { offBoard }) })
const offBoardOf = (config: Config, gh: ReturnType<typeof fakeGh>) => lintBoard(fetchSnapshot(gh.run, config, NOW), config, NOW).filter((finding) => finding.rule === 'B-OFF-BOARD').map((finding) => finding.subject)

describe('the off-board scope on a shared repository', () => {
  const rawOpen = [rawIssue(1), rawIssue(2, ['team:loom']), rawIssue(3, ['team:other']), rawIssue(4, [], ['alice'])]

  it('flags every open issue that is not on the board by default, as before', () => {
    const gh = fakeGh([1], rawOpen)
    assert.deepEqual(offBoardOf(withScope(undefined), gh), ['app#2', 'app#3', 'app#4'])
    assert.equal(gh.issueLists[0]?.at(-1), 'number,author')
  })

  it('flags nothing with `none`, and does not list the repository\'s issues at all', () => {
    const gh = fakeGh([1], rawOpen)
    assert.deepEqual(offBoardOf(withScope({ scope: 'none' }), gh), [])
    assert.deepEqual(gh.issueLists, [])
  })

  it('flags only the issues with a listed label or assignee, and reads those fields', () => {
    const gh = fakeGh([1], rawOpen)
    assert.deepEqual(offBoardOf(withScope(filter), gh), ['app#2', 'app#4'])
    assert.equal(gh.issueLists[0]?.at(-1), 'number,author,labels,assignees')
  })

  it('does not flag a watched issue that is on the board', () => {
    const gh = fakeGh([2], rawOpen)
    assert.deepEqual(offBoardOf(withScope(filter), gh), ['app#4'])
  })
})
