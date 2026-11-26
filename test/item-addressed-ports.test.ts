import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { githubIssueThread } from '../src/adapters/github/issues.ts'
import { boardCommand } from '../src/board/board-command.ts'
import { saveSnapshot } from '../src/board/snapshot.ts'
import { parseConfig } from '../src/config.ts'
import { bodyThreadOf } from '../src/links/body-thread.ts'
import { linkPullRequests } from '../src/links/run.ts'
import { paths, type Paths } from '../src/store.ts'
import { fakePorts } from './fake-ports.ts'
import { config as base, issue, NOW, snapshot } from './helpers.ts'

let p: Paths
beforeEach(() => {
  p = paths(mkdtempSync(join(tmpdir(), 'scrum-item-ports-')))
})

describe('commenting on an item', () => {
  it('goes through the item, which the GitHub adapter turns into its repository and number', () => {
    const calls: string[][] = []
    const thread = githubIssueThread((args) => (calls.push([...args]), ''))
    thread.addComment(issue(14), 'Decision text')
    assert.deepEqual(calls, [['api', '-X', 'POST', 'repos/example-org/app/issues/14/comments', '-f', 'body=Decision text']])
    assert.throws(() => thread.addComment(issue(14, { number: null }), 'x'), /without a number/)
  })
})

describe('linking PRs into issue bodies', () => {
  const links = { ...base, links: { enabled: true, intervalMinutes: 30, maxEditsPerRun: 20, skipAuthors: [], skipBranchPrefixes: [] } }

  it('is the body side of a thread, and a thread without all of it has none', () => {
    const body = { openIssues: () => [], read: () => ({ isOpen: true, body: '' }), writeBody: () => undefined }
    assert.notEqual(bodyThreadOf({ comments: () => [], addComment: () => undefined, ...body }), null)
    assert.equal(bodyThreadOf({ comments: () => [], addComment: () => undefined }), null)
    assert.equal(bodyThreadOf({ comments: () => [], addComment: () => undefined, openIssues: body.openIssues }), null)
  })

  it('does nothing, and reads nothing, when the tracker cannot rewrite bodies', () => {
    const reads: string[] = []
    const thread = { comments: () => [], addComment: () => undefined }
    const result = linkPullRequests(p, links, NOW, { code: { openPullRequests: (repo) => (reads.push(repo), []) }, issues: thread }, { dryRun: false })
    assert.deepEqual([result.planned, result.applied, reads], [[], [], []])
  })
})

describe('a board that cannot add or hand over items', () => {
  const sharedConfig = { ...base, team: { field: 'Team', value: 'node', adoptsUnassigned: true } }
  const writer = (({ addToBoard: _add, setTeam: _set, ...rest }) => rest)(fakePorts().writer)
  const ports = { ...fakePorts(), writer }

  it('says so instead of failing', () => {
    saveSnapshot(p, snapshot([issue(1, { team: 'node' })]))
    assert.match(boardCommand(p, sharedConfig, ports, ['add', '7'], {}), /cannot add an issue from here/)
    assert.match(boardCommand(p, sharedConfig, ports, ['move', '1'], { team: 'clients' }), /cannot hand an item to a team from here/)
  })
})

describe('the GitHub project ids', () => {
  const { projectId: _project, statusFieldId: _status, ...withoutIds } = base

  it('are required without a board module, and optional with one', () => {
    assert.equal(parseConfig(withoutIds), null)
    assert.equal(parseConfig({ ...withoutIds, adapters: { module: '/opt/board/module.mjs' } })?.projectId, '')
    assert.equal(parseConfig({ ...base, adapters: { module: '/opt/board/module.mjs' } })?.projectId, base.projectId)
  })

  it('still have to be text when they are given, also with a board module', () => {
    assert.equal(parseConfig({ ...withoutIds, projectId: 7, adapters: { module: '/opt/board/module.mjs' } }), null)
  })
})
