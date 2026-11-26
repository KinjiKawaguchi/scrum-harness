import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boardEvents } from '../src/activity/board-events.ts'
import { bashActionReader } from '../src/adapters/github/action-reader.ts'
import { handleHook, type HookDeps } from '../src/hooks/handlers.ts'
import { openedPullRequest, readPrAuthors, recordPrAuthor, trimPrAuthors } from '../src/team/pr-authors.ts'
import { paths, type Paths } from '../src/store.ts'
import { fakePorts } from './fake-ports.ts'
import { config, NOW, pr, snapshot } from './helpers.ts'

const bash = (command: string, stdout: string) => ({ tool: 'Bash', input: { command }, response: { stdout, stderr: '', interrupted: false } })
const URL = 'https://github.com/acme/app/pull/42'

describe('openedPullRequest', () => {
  it('names the pull request a `gh pr create` opened from the URL in its result', () => {
    assert.equal(openedPullRequest(bash('gh pr create --title "fix" --body "x"', `Creating pull request\n${URL}\n`)), 'app#42')
  })

  it('reads the command in a chain, with options before the subcommand, and a result that is plain text', () => {
    assert.equal(openedPullRequest(bash('git push -u origin feat/x && gh pr create --fill', URL)), 'app#42')
    assert.equal(openedPullRequest(bash('gh -R acme/app pr create --fill', URL)), 'app#42')
    assert.equal(openedPullRequest({ tool: 'Bash', input: { command: 'gh pr create --fill' }, response: URL }), 'app#42')
  })

  it('reads the URL on a GitHub Enterprise host', () => {
    assert.equal(openedPullRequest(bash('gh pr create --fill', 'https://git.example.test/acme/app/pull/7')), 'app#7')
  })

  it('names the pull request a GitHub MCP tool opened', () => {
    const call = { tool: 'mcp__github__create_pull_request', input: {}, response: { content: [{ type: 'text', text: JSON.stringify({ number: 5, html_url: 'https://github.com/acme/app/pull/5' }) }] } }
    assert.equal(openedPullRequest(call), 'app#5')
  })

  it('is null for any other command, even one that prints a pull request URL, and for a result with no URL', () => {
    assert.equal(openedPullRequest(bash('gh pr view 42 --json url', URL)), null)
    assert.equal(openedPullRequest(bash('gh pr merge 42 --squash', URL)), null)
    assert.equal(openedPullRequest(bash('gh pr create --fill', 'nothing to say')), null)
    assert.equal(openedPullRequest({ tool: 'Bash', input: { command: 'gh pr create --fill' } }), null)
    assert.equal(openedPullRequest({ tool: 'Read', input: {}, response: URL }), null)
  })
})

describe('the record of who opened a pull request', () => {
  let p: Paths
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-pr-authors-')))
  })

  it('keeps the first member named for a pull request, and the base name of a member', () => {
    recordPrAuthor(p.prAuthors, { at: '2026-11-26T09:00:00Z', name: 'SWE1 (2)', sessionId: 's1', ref: 'app#42' })
    recordPrAuthor(p.prAuthors, { at: '2026-11-26T09:05:00Z', name: 'SWE2', sessionId: 's2', ref: 'app#42' })
    assert.deepEqual([...readPrAuthors(p.prAuthors)], [['app#42', 'SWE1']])
  })

  it('drops a record older than 90 days and a line it cannot read, and leaves the file alone when nothing is old', () => {
    recordPrAuthor(p.prAuthors, { at: '2026-05-01T09:00:00Z', name: 'SWE1', sessionId: 's1', ref: 'app#1' })
    recordPrAuthor(p.prAuthors, { at: '2026-11-20T09:00:00Z', name: 'SWE2', sessionId: 's2', ref: 'app#2' })
    trimPrAuthors(p.prAuthors, NOW)
    assert.deepEqual([...readPrAuthors(p.prAuthors)], [['app#2', 'SWE2']])
    const before = readFileSync(p.prAuthors, 'utf8')
    trimPrAuthors(p.prAuthors, NOW)
    assert.equal(readFileSync(p.prAuthors, 'utf8'), before)
  })
})

describe('the hook', () => {
  let p: Paths
  const deps = (name: string | null): HookDeps => ({
    p,
    config,
    now: NOW,
    identity: name === null ? null : { sessionId: `sid-${name}`, name, pid: null },
    ports: { actions: bashActionReader(config), code: fakePorts().code, sessions: fakePorts().sessions },
    spawnRefresh: () => undefined,
    spawnCheckpoint: () => undefined,
  })
  const input = (command: string, stdout: string) => ({ session_id: 'sid', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout } })
  beforeEach(() => {
    p = paths(mkdtempSync(join(tmpdir(), 'scrum-pr-hook-')))
  })

  it('records the member whose session opened a pull request, whatever its role', () => {
    handleHook('PostToolUse', input('gh pr create --fill', URL), deps('SWE1'))
    handleHook('PostToolUse', input('gh pr create --fill', 'https://github.com/acme/app/pull/43'), deps('TechLead'))
    assert.deepEqual([...readPrAuthors(p.prAuthors)], [['app#42', 'SWE1'], ['app#43', 'TechLead']])
  })

  it('records nothing for another command, or for a session outside the team', () => {
    handleHook('PostToolUse', input('gh pr view 42', URL), deps('SWE1'))
    handleHook('PostToolUse', input('gh pr create --fill', URL), deps('Stranger'))
    handleHook('PostToolUse', input('gh pr create --fill', URL), deps(null))
    assert.equal(readPrAuthors(p.prAuthors).size, 0)
  })
})

describe('the activity events of a pull request', () => {
  const board = snapshot([pr(42, { openedAt: '2026-11-26T09:00:00Z', mergedAt: '2026-11-26T10:00:00Z' }), pr(43, { openedAt: '2026-11-26T09:30:00Z' })])

  it('name who opened it when the hooks saw it, and say nothing of a pull request they did not', () => {
    const events = boardEvents(null, board, config, new Map([['app#42', 'SWE1']]))
    assert.deepEqual(events.map((one) => [one.kind, 'ref' in one ? one.ref : '', 'by' in one ? one.by : undefined]), [
      ['prOpened', 'app#42', 'SWE1'],
      ['prMerged', 'app#42', 'SWE1'],
      ['prOpened', 'app#43', undefined],
    ])
  })

  it('are the same as before when no one is named', () => {
    assert.equal(boardEvents(null, board, config).some((one) => 'by' in one), false)
  })
})
